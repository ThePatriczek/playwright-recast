import * as fs from 'node:fs'
import * as path from 'node:path'
import type { StageDescriptor } from './stages.js'
import type { ParsedTrace, FilteredTrace, TraceAction } from '../types/trace.js'
import { toMonotonic } from '../types/trace.js'
import type { SpeedMappedTrace } from '../types/speed.js'
import type { SubtitledTrace } from '../types/subtitle.js'
import type { VoiceoveredTrace } from '../types/voiceover.js'
import { parseTrace } from '../parse/trace-parser.js'
import { filterSteps } from '../filter/step-filter.js'
import { processSpeed } from '../speed/speed-processor.js'
import { generateSubtitles } from '../subtitles/subtitle-generator.js'
import { parseSrt } from '../subtitles/srt-parser.js'
import { generateVoiceover } from '../voiceover/voiceover-processor.js'
import { renderVideo, detectBlankLeadIn, type RenderableTrace } from '../render/renderer.js'
import { processText } from '../text-processing/text-processor.js'
import { writeSrt } from '../subtitles/srt-writer.js'
import { writeVtt } from '../subtitles/vtt-writer.js'
import { assertFfmpegAvailable } from '../utils/ffmpeg.js'

type PipelineState = {
  parsed?: ParsedTrace
  filtered?: FilteredTrace
  speedMapped?: SpeedMappedTrace
  subtitled?: SubtitledTrace
  voiceovered?: VoiceoveredTrace
  sourceVideoPath?: string
  _blankTrimApplied?: boolean
}

/**
 * Executes a pipeline by walking through stages sequentially.
 * Each stage transforms the state into the next type in the chain.
 */
export class PipelineExecutor {
  constructor(
    private readonly source: string,
    private readonly stages: readonly StageDescriptor[],
  ) {}

  async execute(outputPath: string): Promise<void> {
    assertFfmpegAvailable()
    const state = await this.runStages()
    const outputDir = path.dirname(outputPath)
    const tmpDir = path.join(outputDir, '.recast-tmp')
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.mkdirSync(outputDir, { recursive: true })

    // Find the render config
    const renderStage = this.stages.find((s) => s.type === 'render')
    const renderConfig = renderStage?.type === 'render' ? renderStage.config : {}

    // Determine the most advanced state for rendering
    const renderableTrace = state.voiceovered ?? state.subtitled ?? state.speedMapped ?? state.filtered ?? state.parsed

    if (!renderableTrace) {
      throw new Error('Pipeline has no data to render. Did you call .parse()?')
    }

    // Build the renderable trace with source video and optional subtitle/voiceover fields
    const traceWithVideo: RenderableTrace = {
      ...renderableTrace,
      sourceVideoPath: state.sourceVideoPath,
      subtitles: state.subtitled?.subtitles,
      voiceover: state.voiceovered?.voiceover,
      speedSegments: state.speedMapped?.speedSegments,
    }

    // Render final video
    renderVideo(traceWithVideo, renderConfig, outputPath, tmpDir)

    // Write subtitle files next to the output
    if (state.subtitled) {
      const baseName = path.basename(outputPath, path.extname(outputPath))
      const srtPath = path.join(outputDir, `${baseName}.srt`)
      const vttPath = path.join(outputDir, `${baseName}.vtt`)
      fs.writeFileSync(srtPath, writeSrt(state.subtitled.subtitles))
      fs.writeFileSync(vttPath, writeVtt(state.subtitled.subtitles))
    }

    // Write report.json
    if (state.parsed) {
      const reportPath = path.join(outputDir, 'report.json')
      const report = {
        scenario: 'playwright-recast output',
        sourceVideo: state.sourceVideoPath,
        actionsCount: state.parsed.actions.length,
        framesCount: state.parsed.frames.length,
        resourcesCount: state.parsed.resources.length,
        subtitlesCount: state.subtitled?.subtitles.length ?? 0,
        voiceoverSegments: state.voiceovered?.voiceover.entries.length ?? 0,
        outputFile: path.basename(outputPath),
      }
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    }

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true })

    // Dispose frame reader
    state.parsed?.frameReader.dispose()
  }

  async executeToBuffer(): Promise<Buffer> {
    const tmpOutput = path.join('/tmp', `recast-${Date.now()}.mp4`)
    await this.execute(tmpOutput)
    const buffer = fs.readFileSync(tmpOutput)
    fs.unlinkSync(tmpOutput)
    return buffer
  }

  private async runStages(): Promise<PipelineState> {
    const state: PipelineState = {}

    // Find source video in the trace directory
    state.sourceVideoPath = this.findSourceVideo()

    for (const stage of this.stages) {
      switch (stage.type) {
        case 'parse': {
          const tracePath = this.findTraceZip()
          state.parsed = await parseTrace(tracePath)
          // Default filter (no-op) for downstream stages
          state.filtered = {
            ...state.parsed,
            originalActions: state.parsed.actions,
            hiddenRanges: [],
          }
          break
        }

        case 'hideSteps': {
          if (!state.parsed) throw new Error('hideSteps() requires parse() first')
          state.filtered = filterSteps(state.parsed, stage.predicate)
          break
        }

        case 'speedUp': {
          if (!state.filtered) throw new Error('speedUp() requires parse() first')
          state.speedMapped = processSpeed(state.filtered, stage.config)
          const segs = state.speedMapped.speedSegments
          const uniqueSpeeds = [...new Set(segs.map(s => s.speed))]
          console.log(`  speedUp: ${segs.length} segments, speeds: [${uniqueSpeeds.map(s => s + 'x').join(', ')}], output: ${(state.speedMapped.outputDuration / 1000).toFixed(1)}s`)
          break
        }

        case 'subtitles': {
          // If no speed processing, create a pass-through speed map
          if (!state.speedMapped && state.filtered) {
            state.speedMapped = {
              ...state.filtered,
              speedSegments: [],
              timeRemap: (t) => t as number,
              outputDuration: (state.filtered.metadata.endTime as number) - (state.filtered.metadata.startTime as number),
            }
          }
          if (!state.speedMapped) throw new Error('subtitles() requires parse() first')
          state.subtitled = generateSubtitles(state.speedMapped, stage.textFn, stage.options)
          break
        }

        case 'subtitlesFromSrt': {
          // Load subtitles directly from an existing SRT file
          const srtContent = fs.readFileSync(stage.srtPath, 'utf-8')
          const subtitles = parseSrt(srtContent)

          // Promote to SubtitledTrace, filling in any missing intermediate fields
          const srtBase = state.speedMapped ?? state.filtered ?? state.parsed
          if (!srtBase) throw new Error('subtitlesFromSrt() requires parse() first')

          const asFiltered: FilteredTrace = 'originalActions' in srtBase
            ? srtBase as FilteredTrace
            : { ...srtBase, originalActions: srtBase.actions, hiddenRanges: [] }

          const asSpeedMapped: SpeedMappedTrace = 'speedSegments' in srtBase
            ? srtBase as SpeedMappedTrace
            : { ...asFiltered, speedSegments: [], timeRemap: (t) => t as number, outputDuration: 0 }

          // Remap subtitle times through the speed map when speed processing is active.
          // SRT times are in video time (starting from 0 for first visible step).
          // Use the first screencast frame from the RECORDING page (identified by the
          // last frame's pageId) as the trace-time baseline — matches the renderer.
          if (state.speedMapped && state.speedMapped.speedSegments.length > 0 && state.parsed) {
            const frames = state.parsed.frames
            const recPageId = frames.length > 0
              ? frames[frames.length - 1]!.pageId : undefined

            // SRT time 0 = step 1 start = first ACTION on the recording page.
            // Video time 0 = first FRAME from the recording page (after blank trim).
            // These differ by ~1s (action starts before frame renders).
            // Use the action time for subtitle mapping so content matches exactly.
            const recActions = state.parsed.actions.filter((a) => a.pageId === recPageId)
            const firstRecActionMs = recActions.length > 0
              ? (recActions[0]!.startTime as number) : 0

            const recFrames = recPageId
              ? frames.filter((f) => f.pageId === recPageId) : frames
            const firstRecFrameMs = recFrames[0]?.timestamp as number ??
              (state.speedMapped.speedSegments[0]!.originalStart as number)

            // Video output starts at the first frame. Subtract this offset so
            // subtitle time 0 aligns with video time 0.
            const videoStartOutput = state.speedMapped.timeRemap(toMonotonic(firstRecFrameMs))

            for (const sub of subtitles) {
              sub.startMs = Math.max(0, state.speedMapped.timeRemap(toMonotonic(sub.startMs + firstRecActionMs)) - videoStartOutput)
              sub.endMs = Math.max(0, state.speedMapped.timeRemap(toMonotonic(sub.endMs + firstRecActionMs)) - videoStartOutput)
            }

            // If a subtitle's start lands inside a fast-forward zone (>5x),
            // push it to right after the zone ends. Preserve the original
            // window duration and ensure no overlap with the next subtitle.
            const segs = state.speedMapped.speedSegments
            for (let i = 0; i < subtitles.length; i++) {
              const sub = subtitles[i]!
              for (const seg of segs) {
                if (seg.speed <= 5) continue
                const zoneStart = seg.outputStart - videoStartOutput
                const zoneEnd = seg.outputEnd - videoStartOutput
                if (sub.startMs >= zoneStart && sub.startMs < zoneEnd) {
                  const windowDuration = sub.endMs - sub.startMs
                  sub.startMs = zoneEnd
                  sub.endMs = sub.startMs + windowDuration
                  // Cap to not overlap with next subtitle
                  const next = subtitles[i + 1]
                  if (next && sub.endMs > next.startMs) {
                    sub.endMs = next.startMs
                  }
                  break
                }
              }
            }
          }

          state.subtitled = { ...asSpeedMapped, subtitles }
          break
        }

        case 'subtitlesFromTrace': {
          // Generate subtitles from BDD step titles extracted from the parsed trace actions.
          // Uses action.text (BDD step text) or falls back to action.title.
          const traceBase = state.speedMapped ?? state.filtered ?? state.parsed
          if (!traceBase) throw new Error('subtitlesFromTrace() requires parse() first')

          // Ensure we have a SpeedMappedTrace (create pass-through if missing)
          let speedMapped: SpeedMappedTrace
          if (state.speedMapped) {
            speedMapped = state.speedMapped
          } else {
            const filtered: FilteredTrace = state.filtered ?? {
              ...state.parsed!,
              originalActions: state.parsed!.actions,
              hiddenRanges: [],
            }
            speedMapped = {
              ...filtered,
              speedSegments: [],
              timeRemap: (t) => t as number,
              outputDuration: (filtered.metadata.endTime as number) - (filtered.metadata.startTime as number),
            }
          }

          // Extract BDD step text from trace actions
          const defaultTextFn = (action: TraceAction): string | undefined =>
            action.text ?? (action.keyword ? `${action.keyword} ${action.title}` : undefined)

          state.subtitled = generateSubtitles(speedMapped, defaultTextFn, stage.options)
          break
        }

        case 'textProcessing': {
          if (!state.subtitled) {
            throw new Error('textProcessing() requires subtitles() first')
          }
          for (const subtitle of state.subtitled.subtitles) {
            subtitle.ttsText = processText(subtitle.text, stage.config)
          }
          break
        }

        case 'enrichZoomFromReport': {
          if (!state.subtitled) throw new Error('enrichZoomFromReport() requires subtitles() first')
          const reportSteps = stage.steps
          for (let i = 0; i < Math.min(state.subtitled.subtitles.length, reportSteps.length); i++) {
            const z = reportSteps[i]?.zoom
            if (z) {
              state.subtitled.subtitles[i]!.zoom = { x: z.x, y: z.y, level: z.level }
            }
          }
          break
        }

        case 'autoZoom': {
          if (!state.subtitled) throw new Error('autoZoom() requires subtitles() first')
          if (!state.parsed) throw new Error('autoZoom() requires parse() first')

          const clickLevel = stage.config.clickLevel ?? stage.config.actionLevel ?? 1.5
          const inputLevel = stage.config.inputLevel ?? 1.6
          const idleLevel = stage.config.idleLevel ?? 1.0
          const centerBias = stage.config.centerBias ?? 0.2
          const viewport = state.parsed.metadata.viewport

          const firstFrameTime = state.parsed.frames.length > 0
            ? (state.parsed.frames[0]!.timestamp as number)
            : (state.parsed.metadata.startTime as number)

          const INPUT_METHODS = new Set(['fill', 'type', 'press'])
          const CLICK_METHODS = new Set(['click', 'selectOption'])
          const ALL_METHODS = new Set([...INPUT_METHODS, ...CLICK_METHODS])

          // All user actions with video-relative timing (ms)
          const allActions = state.parsed.actions
            .map((a) => ({
              method: a.method,
              videoStartMs: Math.round(((a.startTime as number) - firstFrameTime)),
              videoEndMs: Math.round(((a.endTime as number) - firstFrameTime)),
              point: a.point as { x: number; y: number } | undefined,
              isInput: INPUT_METHODS.has(a.method),
              isUser: ALL_METHODS.has(a.method),
            }))
            .filter((a) => a.videoStartMs >= 0)

          const userActions = allActions.filter((a) => a.isUser)
          const pointActions = userActions.filter((a) => a.point)

          for (const subtitle of state.subtitled.subtitles) {
            if (subtitle.zoom) continue // already set by enrichZoomFromReport

            // Find input actions (fill/type) within this subtitle window
            const inputActions = userActions.filter(
              (a) => a.isInput &&
                a.videoStartMs >= subtitle.startMs - 1000 &&
                a.videoStartMs <= subtitle.endMs + 1000,
            )

            // Find click actions within this subtitle window
            const clickActions = userActions.filter(
              (a) => !a.isInput &&
                a.videoStartMs >= subtitle.startMs - 1000 &&
                a.videoStartMs <= subtitle.endMs + 1000,
            )

            const hasInput = inputActions.length > 0
            const hasClick = clickActions.length > 0
            const level = hasInput ? inputLevel : hasClick ? clickLevel : idleLevel

            if (level <= 1.0) continue

            // Determine zoom target and window from the trace
            const targetAction = hasInput ? inputActions[0]! : clickActions[0]!

            // Zoom window: from action start to next user action (or subtitle end).
            // This follows the trace rhythm — zoom holds while element is visible.
            const zoomStartMs = targetAction.videoStartMs
            const nextAction = userActions.find((a) => a.videoStartMs > targetAction.videoStartMs + 100)
            const zoomEndMs = nextAction
              ? Math.min(nextAction.videoStartMs, subtitle.endMs)
              : subtitle.endMs

            // Skip if zoom window is too short (<500ms)
            if (zoomEndMs - zoomStartMs < 500) continue

            // Find best cursor coordinates
            let bestPoint: { x: number; y: number } | undefined

            if (targetAction.point) {
              bestPoint = targetAction.point
            } else {
              // No point on this action — find nearest action with coordinates
              const nearest = pointActions
                .map((a) => ({ ...a, dist: Math.abs(a.videoStartMs - targetAction.videoStartMs) }))
                .sort((a, b) => a.dist - b.dist)
              if (nearest.length > 0 && nearest[0]!.dist < 10000) {
                bestPoint = nearest[0]!.point
              }
            }

            if (!bestPoint) continue

            const rawX = bestPoint.x / viewport.width
            const rawY = bestPoint.y / viewport.height
            subtitle.zoom = {
              x: rawX + (0.5 - rawX) * centerBias,
              y: rawY + (0.5 - rawY) * centerBias,
              level,
              startMs: zoomStartMs,
              endMs: zoomEndMs,
            }
          }
          break
        }

        case 'voiceover': {
          if (!state.subtitled) throw new Error('voiceover() requires subtitles() first')

          // Compensate for blank lead-in BEFORE generating voiceover so the
          // audio track timing matches the trimmed video.
          if (state.sourceVideoPath && !state._blankTrimApplied) {
            const blankTmpDir = path.join(path.dirname(state.sourceVideoPath), '.recast-blank-tmp')
            fs.mkdirSync(blankTmpDir, { recursive: true })
            const blankLeadIn = detectBlankLeadIn(state.sourceVideoPath, blankTmpDir)
            fs.rmSync(blankTmpDir, { recursive: true, force: true })
            if (blankLeadIn > 0) {
              const offsetMs = blankLeadIn * 1000
              for (const sub of state.subtitled.subtitles) {
                sub.startMs = Math.max(0, sub.startMs - offsetMs)
                sub.endMs = Math.max(0, sub.endMs - offsetMs)
              }
            }
            state._blankTrimApplied = true
          }

          const tmpDir = path.join(path.dirname(state.sourceVideoPath ?? '/tmp'), '.recast-vo-tmp')
          state.voiceovered = await generateVoiceover(state.subtitled, stage.provider, tmpDir)
          break
        }

        case 'render':
          // Apply blank trim compensation for subtitle-only mode (no voiceover)
          if (state.subtitled && state.sourceVideoPath && !state._blankTrimApplied) {
            const blankTmpDir = path.join(path.dirname(state.sourceVideoPath), '.recast-blank-tmp')
            fs.mkdirSync(blankTmpDir, { recursive: true })
            const blankLeadIn = detectBlankLeadIn(state.sourceVideoPath, blankTmpDir)
            fs.rmSync(blankTmpDir, { recursive: true, force: true })
            if (blankLeadIn > 0) {
              const offsetMs = blankLeadIn * 1000
              for (const sub of state.subtitled.subtitles) {
                sub.startMs = Math.max(0, sub.startMs - offsetMs)
                sub.endMs = Math.max(0, sub.endMs - offsetMs)
              }
            }
            state._blankTrimApplied = true
          }
          break
      }
    }

    return state
  }

  private findTraceZip(): string {
    // Check if source is a zip file directly
    if (this.source.endsWith('.zip') && fs.existsSync(this.source)) {
      return this.source
    }

    // Search in directory for trace.zip
    if (fs.existsSync(this.source) && fs.statSync(this.source).isDirectory()) {
      const traceZip = path.join(this.source, 'trace.zip')
      if (fs.existsSync(traceZip)) return traceZip

      // Search subdirectories
      for (const entry of fs.readdirSync(this.source, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const subTrace = path.join(this.source, entry.name, 'trace.zip')
          if (fs.existsSync(subTrace)) return subTrace
        }
      }
    }

    throw new Error(`No trace.zip found at: ${this.source}`)
  }

  private findSourceVideo(): string | undefined {
    const dir = this.source.endsWith('.zip')
      ? path.dirname(this.source)
      : this.source

    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return undefined

    // Search for .webm files
    const searchDir = (d: string): string | undefined => {
      for (const file of fs.readdirSync(d)) {
        if (file.endsWith('.webm')) return path.join(d, file)
      }
      // Check subdirectories
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const found = searchDir(path.join(d, entry.name))
          if (found) return found
        }
      }
      return undefined
    }

    return searchDir(dir)
  }
}
