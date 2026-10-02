import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'
import type { StageDescriptor } from './stages.js'
import type { ParsedTrace, FilteredTrace, ScreencastFrame, TraceAction, TracePage } from '../types/trace.js'
import { toMonotonic } from '../types/trace.js'
import type { SpeedConfig, SpeedMappedTrace } from '../types/speed.js'
import type { SubtitledTrace } from '../types/subtitle.js'
import {
  NARRATE_TITLE_PREFIX,
  HIGHLIGHT_TITLE_PREFIX,
  ZOOM_TITLE_PREFIX,
} from '../helpers.js'
import { buildNarrationSubtitles, isNarrationBoundaryTitle, sceneOf } from './narration-subtitles.js'
import { cueForZoomMarker } from './zoom-markers.js'
import {
  parseClickMarkersFromRecordingContext,
  resolveClickMarkers,
  type AutoClick,
} from './click-markers.js'
import type { VoiceoveredTrace } from '../types/voiceover.js'
import { parseTrace } from '../parse/trace-parser.js'
import { recordingFrame } from '../parse/recording-frame.js'
import { jpegSize } from '../parse/jpeg.js'
import { filterSteps } from '../filter/step-filter.js'
import { processSpeed } from '../speed/speed-processor.js'
import { generateSubtitles } from '../subtitles/subtitle-generator.js'
import { parseSrt } from '../subtitles/srt-parser.js'
import { generateVoiceover } from '../voiceover/voiceover-processor.js'
import { renderVideo, detectBlankLeadIn, probeVideoFps, probeResolution, getVideoDuration, type RenderableTrace } from '../render/renderer.js'
import {
  resolveBlankLeadInMs,
  shiftSubtitlesForBlankLead,
  shiftOverlayTimesForBlankLead,
} from './blank-lead.js'
import {
  assembleVideoFromScreencastFrames,
  selectRecordingPageFrames,
} from '../render/screencast-assembler.js'
import { processText } from '../text-processing/text-processor.js'
import { writeSrt } from '../subtitles/srt-writer.js'
import { writeVtt } from '../subtitles/vtt-writer.js'
import { assertFfmpegAvailable } from '../utils/ffmpeg.js'
import type { ClickEvent } from '../types/click-effect.js'
import { resolveClickEffectConfig } from '../click-effect/defaults.js'
import type { CursorKeyframe } from '../types/cursor-overlay.js'
import { resolveCursorOverlayConfig, type ResolvedCursorOverlayConfig } from '../cursor-overlay/defaults.js'
import { buildTrajectory } from '../cursor-overlay/trajectory.js'
import type { HighlightEvent } from '../types/text-highlight.js'
import { resolveTextHighlightConfig, type ResolvedTextHighlightConfig } from '../text-highlight/defaults.js'
import type { IntroConfig, OutroConfig } from '../types/intro-outro.js'
import { applyIntroOutro } from '../render/intro-outro.js'
import { resolveBackgroundMusicConfig, type ResolvedBackgroundMusicConfig } from '../background-music/defaults.js'
import { generateMusicTrack } from '../background-music/music-processor.js'
import { directVideo } from '../director/renderer.js'
import { approachHold } from '../voiceover/frame-align.js'
import { validateDirectorOptions } from '../director/planner.js'
import type { DirectorOptions, DirectorProvider } from '../types/director.js'
import { URL_TITLE_PREFIX } from '../helpers.js'
import type { UrlBarConfig, UrlBarEvent } from '../types/url-bar.js'
import { buildUrlBarCues, type UrlMarker } from '../url-bar/url-bar-events.js'
import { assertCanDrawText } from '../url-bar/pill.js'
import { findPageVideos, findSourceVideo, testVideoPages } from '../pages/page-videos.js'
import {
  activePageAt,
  buildPageTimeline,
  computePageLayouts,
  mapMarkerTitle,
  mapPoint,
  markerPageId,
  primaryPageId,
  type PageSegment,
} from '../pages/page-timeline.js'
import { compositePageVideos } from '../render/page-compositor.js'

/** @internal */
export type PipelineState = {
  parsed?: ParsedTrace
  /** Content rect of a padded single-page video; the renderer crops to it. */
  contentCrop?: { width: number; height: number }
  /** The page videos a composite was cut from, for the report (the composite is a temp file). */
  pageVideos?: string[]
  filtered?: FilteredTrace
  speedMapped?: SpeedMappedTrace
  speedConfig?: SpeedConfig
  subtitled?: SubtitledTrace
  voiceovered?: VoiceoveredTrace
  sourceVideoPath?: string
  _blankTrimApplied?: boolean
  _blankLeadInMs?: number
  clickEvents?: ClickEvent[]
  clickEffectConfig?: ReturnType<typeof resolveClickEffectConfig>
  cursorKeyframes?: CursorKeyframe[]
  cursorOverlayConfig?: ResolvedCursorOverlayConfig
  zoomConfig?: { transitionMs?: number; easing?: import('../types/easing.js').EasingSpec; containInCue?: boolean }
  interpolateConfig?: import('../types/interpolate.js').InterpolateConfig
  highlightEvents?: HighlightEvent[]
  highlightConfig?: ResolvedTextHighlightConfig
  highlightsOnFreezeClock?: boolean
  introConfig?: IntroConfig
  outroConfig?: OutroConfig
  backgroundMusicConfig?: ResolvedBackgroundMusicConfig
  director?: { provider: DirectorProvider; options: DirectorOptions }
  /** Which page is on screen when, once several pages were composited. */
  pageTimeline?: PageSegment[]
  urlBarConfig?: UrlBarConfig
  urlBarEvents?: UrlBarEvent[]
}

/** Array.prototype.findLast, which the build's target lib lacks. */
function findLast<T>(items: ReadonlyArray<T>, match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i]!)) return items[i]
  return undefined
}

/** `actions` without those of the pages `drop` matches, by their pageId or a marker's. */
function withoutPages(actions: TraceAction[], drop: (pageId: string | undefined) => boolean): TraceAction[] {
  return actions.filter((a) =>
    !drop(a.pageId) && !(typeof a.title === 'string' && drop(markerPageId(a.title, a.startTime as number, []))))
}

/**
 * The plain video for the first page: its own when known, else the found one
 * unless it is known to be another page's (the screencast stands in then).
 */
function firstPageVideo(found: string | undefined, videos: ReadonlyMap<string, string>, first: string | undefined): string | undefined {
  const own = first ? videos.get(first) : undefined
  if (own) return own
  return found && [...videos.values()].some((v) => path.resolve(v) === path.resolve(found)) ? undefined : found
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

  /** The composited page video's own temp dir, removed when the run ends, also on failure. */
  private pagesTmpDir?: string

  async execute(outputPath: string): Promise<void> {
    try {
      await this.render(outputPath)
    } finally {
      if (this.pagesTmpDir) fs.rmSync(this.pagesTmpDir, { recursive: true, force: true })
    }
  }

  private async render(outputPath: string): Promise<void> {
    const directors = this.stages.filter(stage => stage.type === 'direct')
    if (directors.length > 1) throw new Error('Only one direct() stage is supported')
    if (directors.length && this.stages.some(stage => stage.type === 'autoZoom' || stage.type === 'enrichZoomFromReport')) throw new Error('direct() owns the camera; remove autoZoom() and enrichZoomFromReport()')
    // The director crops the rendered video, so a URL bar drawn into it would be zoomed with it.
    if (directors.length && this.stages.some(stage => stage.type === 'urlBar')) throw new Error('urlBar() is not supported with direct() yet; remove one of them')
    for (const director of directors) validateDirectorOptions(director.options)
    assertFfmpegAvailable()
    // Before TTS and encoding, which a missing font would waste.
    // The last urlBar() is the one runStages() applies
    const urlBarStage = findLast(this.stages, (st) => st.type === 'urlBar')
    if (urlBarStage?.type === 'urlBar') assertCanDrawText(urlBarStage.config.fontFile)
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

    if (state.urlBarConfig) {
      state.urlBarEvents = this.buildUrlBarEvents(state, state.urlBarConfig)
      console.log(`  urlBar: ${state.urlBarEvents.length} appearance(s) (${state.urlBarConfig.show ?? 'host-change'})`)
    }

    // Compensate click events, cursor keyframes, and highlight events for
    // blank lead-in. The renderer trims blank frames from the start of the
    // video (Phase 1), and voiceover/subtitle timing is already adjusted for
    // this in the voiceover/render cases. But these are computed earlier
    // without the compensation, causing desync when blank lead-in is non-zero.
    // Under speed authority the offset resolves to 0 and nothing is detected
    // or shifted — see resolveBlankLeadInMs().
    if (
      state.sourceVideoPath &&
      !state.director &&
      (state.clickEvents || state.cursorKeyframes || state.highlightEvents || state.urlBarEvents)
    ) {
      const blankTmpDir = path.join(outputDir, '.recast-blank-probe')
      const offsetMs = resolveBlankLeadInMs(
        state.speedMapped?.speedSegments,
        () => {
          fs.mkdirSync(blankTmpDir, { recursive: true })
          try {
            return detectBlankLeadIn(state.sourceVideoPath!, blankTmpDir)
          } finally {
            fs.rmSync(blankTmpDir, { recursive: true, force: true })
          }
        },
      )
      if (offsetMs > 0) {
        if (state.clickEvents) shiftOverlayTimesForBlankLead(state.clickEvents, offsetMs)
        if (state.highlightEvents) {
          shiftOverlayTimesForBlankLead(state.highlightEvents, offsetMs)
          for (const he of state.highlightEvents) {
            he.endTimeMs = Math.max(0, Math.round(he.endTimeMs - offsetMs))
          }
        }
        if (state.cursorKeyframes) {
          for (const kf of state.cursorKeyframes) {
            kf.videoTimeSec = Math.max(0, kf.videoTimeSec - offsetMs / 1000)
          }
        }
        for (const ev of state.urlBarEvents ?? []) {
          ev.videoTimeMs = Math.max(0, Math.round(ev.videoTimeMs - offsetMs))
          if (ev.endTimeMs !== undefined) ev.endTimeMs = Math.max(0, Math.round(ev.endTimeMs - offsetMs))
        }
      }
    }

    // Build the renderable trace with source video and optional subtitle/voiceover fields
    const traceWithVideo: RenderableTrace = {
      ...renderableTrace,
      sourceVideoPath: state.sourceVideoPath,
      ...(state.contentCrop ? { contentCrop: state.contentCrop } : {}),
      preserveLeadIn: Boolean(state.director),
      subtitles: state.director ? state.subtitled?.subtitles.map(({ zoom, ...subtitle }) => subtitle) : state.subtitled?.subtitles,
      voiceover: state.voiceovered?.voiceover,
      speedSegments: state.speedMapped?.speedSegments,
      clickEvents: state.clickEvents,
      clickEffectConfig: state.clickEffectConfig,
      cursorKeyframes: state.cursorKeyframes,
      cursorOverlayConfig: state.director && !state.voiceovered && state.cursorOverlayConfig ? { ...state.cursorOverlayConfig, approachMs: 0 } : state.cursorOverlayConfig,
      zoomConfig: state.zoomConfig,
      interpolateConfig: state.interpolateConfig,
      highlightEvents: state.highlightEvents,
      highlightConfig: state.highlightConfig,
      highlightsOnFreezeClock: state.highlightsOnFreezeClock,
      urlBarEvents: state.urlBarEvents,
      urlBarConfig: state.urlBarConfig,
    }

    // Render final video
    if (state.director) {
      const directorDir = fs.mkdtempSync(path.join(tmpDir, 'director-'))
      const baseVideo = path.join(directorDir, 'base.mp4')
      renderVideo(traceWithVideo, { ...renderConfig, format: 'mp4', codec: 'libx264', burnSubtitles: false, embedSubtitles: Boolean(state.subtitled?.subtitles.length) }, baseVideo, directorDir)
      try {
        const report = await directVideo(baseVideo, outputPath, state.director.provider, state.director.options, renderConfig, directorDir, Boolean(state.voiceovered))
        if (state.subtitled) state.subtitled.subtitles = report.subtitles
      } catch (error) {
        state.parsed?.frameReader.dispose()
        throw error
      }
    } else renderVideo(traceWithVideo, renderConfig, outputPath, tmpDir)

    // Phase 6: Apply intro/outro with crossfade transitions
    if (state.introConfig || state.outroConfig) {
      applyIntroOutro(outputPath, state.introConfig, state.outroConfig, tmpDir)
    }

    // Phase 7: Mix background music into the final video (after intro/outro
    // so music covers the entire output including intro/outro segments).
    if (state.backgroundMusicConfig) {
      const { getVideoDuration, ffmpeg } = await import('../render/renderer.js')
      const finalDur = getVideoDuration(outputPath)

      // Extract voiceover segment timings for ducking.
      // Offset by intro duration so ducking aligns with voiceover in the final video.
      let introDurationSec = 0
      if (state.introConfig) {
        const introDur = getVideoDuration(state.introConfig.path)
        const fadeSec = (state.introConfig.fadeDuration ?? 500) / 1000
        introDurationSec = introDur - fadeSec // crossfade overlap
      }
      const introOffsetMs = introDurationSec * 1000

      const voiceoverSegments = state.voiceovered?.voiceover.entries
        ? (state.voiceovered.voiceover.entries as Array<{ outputStartMs: number; outputEndMs: number }>)
            .map(e => ({ startMs: e.outputStartMs + introOffsetMs, endMs: e.outputEndMs + introOffsetMs }))
        : []

      const musicTrackPath = generateMusicTrack(
        state.backgroundMusicConfig,
        finalDur,
        voiceoverSegments,
        tmpDir,
      )
      console.log(`  Background music: generated ${finalDur.toFixed(1)}s track (covers intro/outro)`)

      // Mix music into the final video's audio track
      const musicOutputPath = path.join(tmpDir, 'final-with-music.mp4')
      const hasExistingAudio = (() => {
        try {
          const out = execFileSync('ffprobe', [
            '-v', 'quiet', '-select_streams', 'a',
            '-show_entries', 'stream=index', '-of', 'csv=p=0', outputPath,
          ]).toString().trim()
          return out.length > 0
        } catch { return false }
      })()

      if (hasExistingAudio) {
        ffmpeg([
          '-y', '-i', outputPath, '-i', musicTrackPath,
          '-filter_complex',
          '[0:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a0];' +
          '[1:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a1];' +
          '[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]',
          '-map', '0:v', '-map', '[aout]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', musicOutputPath,
        ])
      } else {
        ffmpeg([
          '-y', '-i', outputPath, '-i', musicTrackPath,
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', musicOutputPath,
        ])
      }

      fs.copyFileSync(musicOutputPath, outputPath)
    }

    // Write subtitle files next to the output
    if (state.subtitled) {
      const baseName = path.basename(outputPath, path.extname(outputPath))
      const srtPath = path.join(outputDir, `${baseName}.srt`)
      const vttPath = path.join(outputDir, `${baseName}.vtt`)
      fs.writeFileSync(srtPath, writeSrt(state.subtitled.subtitles))
      fs.writeFileSync(vttPath, writeVtt(state.subtitled.subtitles))
    }

    // Write recast-report.json (separate from demo-report-writer's report.json)
    if (state.parsed) {
      const reportPath = path.join(outputDir, 'recast-report.json')
      const report = {
        scenario: 'playwright-recast output',
        sourceVideo: state.pageVideos?.[0] ?? state.sourceVideoPath,
        ...(state.pageVideos ? { pageVideos: state.pageVideos } : {}),
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

  /** @internal Exposed for tests. */
  async runStages(): Promise<PipelineState> {
    const state: PipelineState = {}

    // Find source video in the trace directory
    state.sourceVideoPath = this.findSourceVideo()

    for (const stage of this.stages) {
      switch (stage.type) {
        case 'direct': {
          if (!state.parsed) throw new Error('direct() requires parse() first')
          state.director = { provider: stage.provider, options: stage.options }
          break
        }
        case 'parse': {
          const tracePath = this.findTraceZip()
          state.parsed = await parseTrace(tracePath)
          const videoPages = testVideoPages(state.parsed.actions)
          const pagesVideo = await this.compositePages(state, path.dirname(tracePath), videoPages)
          if (pagesVideo) state.sourceVideoPath = pagesVideo
          else {
            const { parsed, first, leftOut } = this.firstPageOnly(state.parsed, videoPages)
            state.parsed = parsed
            state.sourceVideoPath = firstPageVideo(state.sourceVideoPath, findPageVideos(path.dirname(tracePath), videoPages), first)
            if (leftOut) this.warnAboutLeftOutPages(videoPages)
          }
          // Default filter (no-op) for downstream stages
          state.filtered = {
            ...state.parsed,
            originalActions: state.parsed.actions,
            hiddenRanges: [],
          }
          if (!state.sourceVideoPath) {
            state.sourceVideoPath = await this.assembleFallbackVideo(state.parsed)
          }
          break
        }

        case 'injectActions': {
          if (!state.parsed) throw new Error('injectActions() requires parse() first')
          // Merge synthetic actions into the parsed trace
          state.parsed = {
            ...state.parsed,
            actions: [...state.parsed.actions, ...stage.actions]
              .sort((a, b) => (a.startTime as number) - (b.startTime as number)),
            cursorPositions: [
              ...state.parsed.cursorPositions,
              ...stage.actions
                .filter((a) => a.point)
                .map((a) => a.point!),
            ].sort((a, b) => (a.timestamp as number) - (b.timestamp as number)),
          }
          // Re-create filtered with merged actions
          state.filtered = {
            ...state.parsed,
            originalActions: state.parsed.actions,
            hiddenRanges: [],
          }
          console.log(`  injectActions: ${stage.actions.length} synthetic actions merged (total: ${state.parsed.actions.length})`)
          break
        }

        case 'hideSteps': {
          if (!state.parsed) throw new Error('hideSteps() requires parse() first')
          state.filtered = filterSteps(state.parsed, stage.predicate)
          // If speedUp() already ran, its segments were built without the new
          // hiddenRanges — rebuild so the renderer actually cuts the hidden
          // portions out of the video.
          if (state.speedMapped && state.speedConfig) {
            state.speedMapped = processSpeed(state.filtered, state.speedConfig)
          }
          break
        }

        case 'speedUp': {
          if (!state.filtered) throw new Error('speedUp() requires parse() first')
          state.speedConfig = stage.config
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
            const { pageId: recPageId, firstFrameMs: recFirstFrameMs } = recordingFrame(state.parsed.frames)

            // SRT time 0 = step 1 start = first ACTION on the recording page.
            // Video time 0 = first FRAME from the recording page (after blank trim).
            // These differ by ~1s (action starts before frame renders).
            // Use the action time for subtitle mapping so content matches exactly.
            const firstRecFrameMs = recFirstFrameMs ??
              (state.speedMapped.speedSegments[0]!.originalStart as number)
            // No action with the page's id (pageId is optional): both clocks start at the frame
            const firstRecActionMs = (state.parsed.actions.find((a) => a.pageId === recPageId)?.startTime as number | undefined) ??
              firstRecFrameMs

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

          // Output video time = timeRemap(trace) minus the output time of the
          // recording's first frame. The renderer drops any visible segment
          // that falls before that frame (negative source time), so raw
          // timeRemap values sit `videoStartOutput` ms ahead of the rendered
          // video. The SRT, cursor, and click paths all subtract this offset;
          // narration subtitles, highlights, and zoom must do the same, or the
          // freezes and click ripples derived from them drift behind the video.
          let subVideoStartOutput = 0
          if (state.speedMapped && state.speedMapped.speedSegments.length > 0 && state.parsed) {
            const subFirstRecFrameMs = recordingFrame(state.parsed.frames).firstFrameMs ??
              (state.parsed.metadata.startTime as number)
            subVideoStartOutput = state.speedMapped.timeRemap(toMonotonic(subFirstRecFrameMs))
          }
          const toVideoMs = (traceMs: number): number =>
            Math.max(0, speedMapped.timeRemap(toMonotonic(traceMs)) - subVideoStartOutput)

          // If the test used narrate(), prefer the explicit narration spans.
          // narrate() emits a test.step with a marker-prefixed title; each
          // narrate's subtitle spans from its start until the next narrate
          // — or, if waitForNarration() is used, until that marker.
          const boundaryActions = speedMapped.actions.filter(
            (a) =>
              typeof a.title === 'string' && isNarrationBoundaryTitle(a.title),
          )

          const hasVisibleNarrate = boundaryActions.some(
            (a) => typeof a.title === 'string' && a.title.startsWith(NARRATE_TITLE_PREFIX),
          )

          const scene = sceneOf(speedMapped.originalActions)
          if (hasVisibleNarrate) {
            const traceEndMs = toVideoMs(speedMapped.metadata.endTime as number)
            const subtitles = buildNarrationSubtitles(
              boundaryActions.map((a) => ({
                title: a.title as string,
                startTime: a.startTime as number,
                sceneId: scene(a),
              })),
              (t) => toVideoMs(t),
              traceEndMs,
            )
            state.subtitled = { ...speedMapped, subtitles }
          } else {
            // Fall back to BDD step text / titles.
            const defaultTextFn = (action: TraceAction): string | undefined =>
              action.text ?? (action.keyword ? `${action.keyword} ${action.title}` : undefined)
            state.subtitled = generateSubtitles(speedMapped, defaultTextFn, stage.options)
          }

          // Pick up highlight() and zoom() marker steps from the trace so the
          // user doesn't need a separate report.json or an extra pipeline call.

          const hlDefaults = resolveTextHighlightConfig({})
          const traceHighlights: HighlightEvent[] = []
          for (const action of speedMapped.actions) {
            if (typeof action.title !== 'string') continue
            if (!action.title.startsWith(HIGHLIGHT_TITLE_PREFIX)) continue
            try {
              const data = JSON.parse(action.title.slice(HIGHLIGHT_TITLE_PREFIX.length)) as {
                x: number; y: number; width: number; height: number
                color?: string; opacity?: number; duration?: number | 'narration'
                fadeOut?: number; swipeDuration?: number
              }
              const videoTimeMs = Math.round(toVideoMs(action.startTime as number))
              const untilNarrationEnd = data.duration === 'narration'
              // The real end is only known once the voiceover is placed; the
              // renderer sets it. The default covers renders without voiceover.
              const duration = typeof data.duration === 'number' ? data.duration : hlDefaults.duration
              const fadeOut = data.fadeOut ?? hlDefaults.fadeOut
              traceHighlights.push({
                x: data.x,
                y: data.y,
                width: data.width,
                height: data.height,
                videoTimeMs,
                endTimeMs: videoTimeMs + duration + fadeOut,
                color: data.color ?? hlDefaults.color,
                opacity: data.opacity ?? hlDefaults.opacity,
                swipeDuration: data.swipeDuration ?? hlDefaults.swipeDuration,
                fadeOut,
                ...(untilNarrationEnd ? { untilNarrationEnd, sceneId: scene(action) } : {}),
                traceMs: action.startTime as number,
              })
            } catch {
              // skip malformed markers
            }
          }
          if (traceHighlights.length > 0) {
            // Overlap is resolved in the renderer, on the freeze-extended
            // timeline — the only clock on which "until the next mark" is a
            // real distance.
            state.highlightEvents = traceHighlights
            state.highlightConfig = hlDefaults
            console.log(`  highlight: ${traceHighlights.length} from trace`)
          }

          if (state.subtitled) {
            for (const action of speedMapped.actions) {
              if (typeof action.title !== 'string') continue
              if (!action.title.startsWith(ZOOM_TITLE_PREFIX)) continue
              try {
                const data = JSON.parse(action.title.slice(ZOOM_TITLE_PREFIX.length)) as {
                  x: number; y: number; level: number
                }
                // Cues start on whole ms; unrounded, a marker in the same ms as its narrate() misses it.
                const tMs = Math.round(toVideoMs(action.startTime as number))
                const sceneId = scene(action)
                const sub = cueForZoomMarker(state.subtitled.subtitles, tMs, sceneId)
                if (sub) {
                  // Start at the zoom() marker when it falls inside the cue,
                  // so the zoom kicks in only once the target is visible; a
                  // marker set before its narration starts with it. The
                  // renderer holds the zoom until `sub.endMs` since we leave
                  // `zoom.endMs` undefined.
                  sub.zoom = {
                    x: data.x,
                    y: data.y,
                    level: data.level,
                    startMs: Math.max(tMs, sub.startMs),
                    ...(sceneId ? { sceneId } : {}),
                  }
                } else if (hasVisibleNarrate) {
                  console.log(`  zoom: dropped a zoom() at ${tMs}ms, no cue of its scene plays or follows`)
                }
              } catch {
                // skip malformed markers
              }
            }
          }
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

          // Only include actions from the recording context
          const recStartZoom = recordingFrame(state.parsed.frames).firstFrameMs ?? firstFrameTime

          const allActions = state.parsed.actions
            .filter((a) => (a.startTime as number) >= recStartZoom)
            .map((a) => ({
              method: a.method,
              videoStartMs: Math.round(((a.startTime as number) - recStartZoom)),
              videoEndMs: Math.round(((a.endTime as number) - recStartZoom)),
              point: a.point as { x: number; y: number } | undefined,
              isInput: INPUT_METHODS.has(a.method),
              isUser: ALL_METHODS.has(a.method),
            }))
            .filter((a) => a.videoStartMs >= 0)

          const userActions = allActions.filter((a) => a.isUser)
          const pointActions = userActions.filter((a) => a.point)

          for (const subtitle of state.subtitled.subtitles) {
            if (subtitle.zoom) continue // already set by enrichZoomFromReport

            // Find input actions (fill/type) within this subtitle window (wider tolerance for timing drift)
            const inputActions = userActions.filter(
              (a) => a.isInput &&
                a.videoStartMs >= subtitle.startMs - 2000 &&
                a.videoStartMs <= subtitle.endMs + 2000,
            )

            // Find click actions within this subtitle window
            const clickActions = userActions.filter(
              (a) => !a.isInput &&
                a.videoStartMs >= subtitle.startMs - 2000 &&
                a.videoStartMs <= subtitle.endMs + 2000,
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

            // For input actions (fill/type) without coordinates, zoom to viewport center.
            // This is better than skipping zoom entirely — fill targets are typically
            // in the main content area.
            if (!bestPoint && targetAction.isInput) {
              bestPoint = { x: viewport.width / 2, y: viewport.height / 2 }
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

          // Pass easing config through to renderer
          state.zoomConfig = {
            transitionMs: stage.config.transitionMs,
            easing: stage.config.easing,
            containInCue: stage.config.containInCue,
          }
          break
        }

        case 'cursorOverlay': {
          if (!state.parsed) throw new Error('cursorOverlay() requires parse() first')

          const cursorConfig = resolveCursorOverlayConfig(stage.config)

          // Base time for video-relative timestamps
          const cursorFirstFrameTime = state.parsed.frames.length > 0
            ? (state.parsed.frames[0]!.timestamp as number)
            : (state.parsed.metadata.startTime as number)

          // Compute time remap + offset for trajectory builder
          let cursorTimeRemap: ((t: number) => number) | undefined
          let cursorVideoStartOffset = cursorFirstFrameTime

          if (state.speedMapped && state.speedMapped.speedSegments.length > 0) {
            const firstRecFrameMs = recordingFrame(state.parsed.frames).firstFrameMs ?? cursorFirstFrameTime
            const videoStartOutput = state.speedMapped.timeRemap(toMonotonic(firstRecFrameMs))
            cursorTimeRemap = (t: number) => state.speedMapped!.timeRemap(toMonotonic(t))
            cursorVideoStartOffset = videoStartOutput
          }

          // Only include actions from the recording context
          const recStartCursor = recordingFrame(state.parsed.frames).firstFrameMs ?? 0
          // Use filtered actions so cursor positions from hidden steps are dropped.
          const cursorSourceActions = state.filtered?.actions ?? state.parsed.actions
          const cursorActionsAll = cursorSourceActions.filter(a => (a.startTime as number) >= recStartCursor)

          // Reconcile markers: drop auto-clicks a marker overrides; the marker
          // contributes its own keyframe below.
          const cursorMarkers = parseClickMarkersFromRecordingContext(cursorSourceActions, recStartCursor)
          const CURSOR_CLICK_METHODS = new Set(['click', 'selectOption'])
          const autoClicksForCursor: AutoClick[] = cursorActionsAll
            .filter((a) => CURSOR_CLICK_METHODS.has(a.method) && a.point)
            .map((a) => ({
              callId: a.callId,
              x: a.point!.x,
              y: a.point!.y,
              startTime: a.startTime as number,
              endTime: a.endTime as number,
            }))
          const { resolved: resolvedCursorClicks, consumedCallIds } = resolveClickMarkers(autoClicksForCursor, cursorMarkers)
          const cursorActions = cursorActionsAll.filter((a) => !consumedCallIds.has(a.callId))

          const keyframes = buildTrajectory({
            actions: cursorActions as Array<{ point?: { x: number; y: number }; startTime: number; endTime?: number }>,
            filter: stage.config.filter as ((a: { point?: { x: number; y: number }; startTime: number }) => boolean) | undefined,
            timeRemap: cursorTimeRemap,
            videoStartOffsetMs: cursorVideoStartOffset,
          })

          // Marker-driven keyframes: at the marker time, full glide (autoWaitSec 0),
          // flagged so the renderer holds the frame for the approach.
          const remapCursor = cursorTimeRemap ?? ((t: number) => t)
          const markerKeyframes: CursorKeyframe[] = resolvedCursorClicks.filter((rc) => rc.marked).map((m) => ({
            x: m.x,
            y: m.y,
            videoTimeSec: Math.max(0, (remapCursor(m.traceTimeMs) - cursorVideoStartOffset) / 1000),
            autoWaitSec: 0,
            approach: true,
            traceMs: m.traceTimeMs,
          }))

          const allKeyframes: CursorKeyframe[] = [...keyframes, ...markerKeyframes].sort(
            (a, b) => a.videoTimeSec - b.videoTimeSec,
          )
          state.cursorKeyframes = allKeyframes
          state.cursorOverlayConfig = cursorConfig
          console.log(`  cursorOverlay: ${allKeyframes.length} keyframes detected`)
          for (const kf of allKeyframes) {
            console.log(`    kf: (${kf.x}, ${kf.y}) @ ${kf.videoTimeSec.toFixed(3)}s`)
          }
          break
        }

        case 'clickEffect': {
          if (!state.parsed) throw new Error('clickEffect() requires parse() first')

          const config = resolveClickEffectConfig(stage.config)
          const CLICK_METHODS = new Set(['click', 'selectOption'])

          // Determine recording context's first frame time
          // (last frame's pageId = recording context, since setup context is created first)
          const recFirstFrameClick = recordingFrame(state.parsed.frames).firstFrameMs
          const recStartClick = recFirstFrameClick ?? 0

          // Use filtered actions so clicks inside hideSteps() ranges are dropped —
          // otherwise they get remapped onto video time 0 (or end) and pile up.
          const sourceActions = state.filtered?.actions ?? state.parsed.actions
          let clickActions = sourceActions.filter(
            (a) => CLICK_METHODS.has(a.method) && a.point && (a.startTime as number) >= recStartClick,
          )

          // Apply user filter if configured
          if (stage.config.filter) {
            clickActions = clickActions.filter(stage.config.filter)
          }

          // Base time for video-relative timestamps
          const firstFrameTime = state.parsed.frames.length > 0
            ? (state.parsed.frames[0]!.timestamp as number)
            : (state.parsed.metadata.startTime as number)

          // Remap to video time. Use the action's END time: with Playwright
          // auto-wait, a click on an element that is still loading only lands
          // (and is visually meaningful) at endTime, which can be seconds
          // after startTime. Positioning the ripple at startTime makes it
          // fire on the loading screen, before the target is visible.
          //
          // Reconcile explicit markers with auto-detected clicks: a marker
          // overrides (suppresses) the matching auto-click and renders at the
          // marker's time; unmatched markers still render; unmarked auto-clicks
          // render at their endTime exactly as before.
          const clickMarkers = parseClickMarkersFromRecordingContext(sourceActions, recStartClick)
          const autoClicksForEffect: AutoClick[] = clickActions.map((a) => ({
            callId: a.callId,
            x: a.point!.x,
            y: a.point!.y,
            startTime: a.startTime as number,
            endTime: a.endTime as number,
          }))
          const { resolved: resolvedClicks } = resolveClickMarkers(autoClicksForEffect, clickMarkers)

          let clickVideoStartOutput = 0
          if (state.speedMapped && state.speedMapped.speedSegments.length > 0) {
            const firstRecFrameMs = recFirstFrameClick ?? firstFrameTime
            clickVideoStartOutput = state.speedMapped.timeRemap(toMonotonic(firstRecFrameMs))
          }
          const remapClickTime = (traceTimeMs: number): number => {
            if (state.speedMapped && state.speedMapped.speedSegments.length > 0) {
              return state.speedMapped.timeRemap(toMonotonic(traceTimeMs)) - clickVideoStartOutput
            }
            return traceTimeMs - firstFrameTime
          }

          const clickEvents: ClickEvent[] = resolvedClicks.map((rc) => ({
            x: rc.x,
            y: rc.y,
            videoTimeMs: Math.max(0, Math.round(remapClickTime(rc.traceTimeMs))),
            traceMs: rc.traceTimeMs,
          }))

          state.clickEvents = clickEvents
          state.clickEffectConfig = config
          console.log(`  clickEffect: ${clickEvents.length} clicks detected`)
          for (const ce of clickEvents) {
            console.log(`    click: (${ce.x}, ${ce.y}) @ ${ce.videoTimeMs}ms`)
          }
          break
        }

        case 'textHighlight': {
          const hlConfig = resolveTextHighlightConfig(stage.config)

          // Read highlight data from report.json next to the trace source
          const reportJsonPath = path.join(path.dirname(this.findTraceZip()), 'report.json')
          if (!fs.existsSync(reportJsonPath)) {
            console.log('  textHighlight: no report.json found')
            break
          }

          const report = JSON.parse(fs.readFileSync(reportJsonPath, 'utf-8')) as {
            steps?: Array<{ hidden?: boolean; highlights?: Array<{ x: number; y: number; width: number; height: number; color?: string; opacity?: number; duration?: number | 'narration'; fadeOut?: number; swipeDuration?: number }> }>
          }

          const subtitles = state.subtitled?.subtitles ?? []
          // Skip hidden steps — subtitles only contain visible steps
          const visibleReportSteps = (report.steps ?? []).filter(s => !s.hidden)
          const highlightEvents: HighlightEvent[] = []

          for (let i = 0; i < Math.min(subtitles.length, visibleReportSteps.length); i++) {
            const hls = visibleReportSteps[i]?.highlights ?? []
            for (const hl of hls) {
              const videoTimeMs = subtitles[i]!.startMs
              const subtitleEndMs = subtitles[i]!.endMs
              const untilNarrationEnd = hl.duration === 'narration'
              const duration = typeof hl.duration === 'number' ? hl.duration : hlConfig.duration
              const fadeOut = hl.fadeOut ?? hlConfig.fadeOut
              // Clamp end time to subtitle boundary — highlight must not overflow into next step
              const rawEndMs = videoTimeMs + duration + fadeOut
              const endTimeMs = Math.min(rawEndMs, subtitleEndMs)
              highlightEvents.push({
                x: hl.x,
                y: hl.y,
                width: hl.width,
                height: hl.height,
                videoTimeMs: Math.max(0, Math.round(videoTimeMs)),
                endTimeMs: Math.round(endTimeMs),
                color: hl.color ?? hlConfig.color,
                opacity: hl.opacity ?? hlConfig.opacity,
                swipeDuration: hl.swipeDuration ?? hlConfig.swipeDuration,
                fadeOut,
                ...(untilNarrationEnd ? { untilNarrationEnd } : {}),
              })
            }
          }

          if (highlightEvents.length === 0) {
            console.log('  textHighlight: no highlights in report')
            break
          }

          const filtered = hlConfig.filter
            ? highlightEvents.filter(hlConfig.filter)
            : highlightEvents

          state.highlightEvents = filtered
          state.highlightConfig = hlConfig
          // These times come from the subtitles, which voiceover() rewrites
          // onto the freeze-extended clock — so after it, they are already
          // shifted and the renderer must not shift them again.
          state.highlightsOnFreezeClock = state.voiceovered !== undefined
          console.log(`  textHighlight: ${filtered.length} highlight(s) from report`)
          for (const he of filtered) {
            console.log(`    highlight: (${he.x}, ${he.y}) ${he.width}x${he.height} @ ${he.videoTimeMs}ms [${he.color}]`)
          }
          break
        }

        case 'pages':
          // Read by the parse stage, which composites the pages
          break

        case 'urlBar': {
          if (!state.parsed) throw new Error('urlBar() requires parse() first')
          state.urlBarConfig = stage.config
          break
        }

        case 'intro': {
          if (!fs.existsSync(stage.config.path)) {
            throw new Error(`Intro video not found: ${stage.config.path}`)
          }
          state.introConfig = stage.config
          console.log(`  intro: ${path.basename(stage.config.path)}`)
          break
        }

        case 'outro': {
          if (!fs.existsSync(stage.config.path)) {
            throw new Error(`Outro video not found: ${stage.config.path}`)
          }
          state.outroConfig = stage.config
          console.log(`  outro: ${path.basename(stage.config.path)}`)
          break
        }

        case 'interpolate': {
          state.interpolateConfig = stage.config
          console.log(`  interpolate: fps=${stage.config.fps ?? 60}, mode=${stage.config.mode ?? 'mci'}, quality=${stage.config.quality ?? 'balanced'}`)
          break
        }

        case 'backgroundMusic': {
          if (!fs.existsSync(stage.config.path)) {
            throw new Error(`Background music file not found: ${stage.config.path}`)
          }
          state.backgroundMusicConfig = resolveBackgroundMusicConfig(stage.config)
          console.log(`  backgroundMusic: ${path.basename(stage.config.path)}`)
          break
        }

        case 'voiceover': {
          if (!state.subtitled) throw new Error('voiceover() requires subtitles() first')

          // Compensate for blank lead-in BEFORE generating voiceover so the
          // audio track timing matches the trimmed video. Under speed
          // authority this resolves to 0: the speed map already defines
          // output time and the source-time blank offset does not belong in
          // it (#20).
          if (state.sourceVideoPath && !state._blankTrimApplied && !this.stages.some(item => item.type === 'direct')) {
            const blankTmpDir = path.join(path.dirname(state.sourceVideoPath), '.recast-blank-tmp')
            state._blankLeadInMs = resolveBlankLeadInMs(
              state.speedMapped?.speedSegments,
              () => {
                fs.mkdirSync(blankTmpDir, { recursive: true })
                try {
                  return detectBlankLeadIn(state.sourceVideoPath!, blankTmpDir)
                } finally {
                  fs.rmSync(blankTmpDir, { recursive: true, force: true })
                }
              },
            )
            shiftSubtitlesForBlankLead(state.subtitled.subtitles, state._blankLeadInMs)
            state._blankTrimApplied = true
          }

          // Approach holds: each click marker becomes a video hold so the cursor
          // can glide over the painted target. Computed here (not in the renderer)
          // so generateVoiceover inserts matching audio silence + shifts subtitles.
          // Positions use the click/cursor formula (timeRemap, minus the
          // recording's first-frame output offset, minus blank lead-in, minus a
          // 2ms margin so the click ripple/cursor reliably shift into the hold)
          // — the same video timeline the clicks and cursor keyframes live in.
          const approachHolds: Array<{ atVideoMs: number; durationMs: number; sourceMs: number }> = []
          if (state.cursorOverlayConfig) {
            const approachMs = state.cursorOverlayConfig.approachMs ?? 500
            const blankMs = state._blankLeadInMs ?? 0
            const remap = (t: number): number => state.subtitled!.timeRemap(toMonotonic(t))
            const recStart = recordingFrame(state.parsed!.frames).firstFrameMs ?? 0
            // Output time of the recording's first frame — same offset the click
            // and cursor stages subtract. Only meaningful once speed segments exist.
            const holdVideoStartOutput =
              state.speedMapped && state.speedMapped.speedSegments.length > 0
                ? remap(recStart)
                : 0
            const markerActions = state.filtered?.actions ?? state.parsed!.actions
            for (const m of parseClickMarkersFromRecordingContext(markerActions, recStart)) {
              const at = Math.round(remap(m.startTime) - holdVideoStartOutput) - blankMs
              approachHolds.push(approachHold(at, Math.round(approachMs)))
            }
          }

          const tmpDir = path.join(path.dirname(state.sourceVideoPath ?? '/tmp'), '.recast-vo-tmp')
          const outputFps = state.sourceVideoPath ? probeVideoFps(state.sourceVideoPath) : 25
          state.voiceovered = await generateVoiceover(
            state.subtitled,
            stage.provider,
            tmpDir,
            stage.options,
            approachHolds,
            outputFps,
          )
          break
        }

        case 'render':
          // Apply blank trim compensation for subtitle-only mode (no
          // voiceover). Resolves to 0 under speed authority — see
          // resolveBlankLeadInMs().
          if (state.subtitled && state.sourceVideoPath && !state._blankTrimApplied && !this.stages.some(item => item.type === 'direct')) {
            const blankTmpDir = path.join(path.dirname(state.sourceVideoPath), '.recast-blank-tmp')
            state._blankLeadInMs = resolveBlankLeadInMs(
              state.speedMapped?.speedSegments,
              () => {
                fs.mkdirSync(blankTmpDir, { recursive: true })
                try {
                  return detectBlankLeadIn(state.sourceVideoPath!, blankTmpDir)
                } finally {
                  fs.rmSync(blankTmpDir, { recursive: true, force: true })
                }
              },
            )
            shiftSubtitlesForBlankLead(state.subtitled.subtitles, state._blankLeadInMs)
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
    return findSourceVideo(this.source.endsWith('.zip') ? path.dirname(this.source) : this.source)
  }

  /** Pages of `primary`'s browser context (one trace file per context). */
  private sameContextAs(pageInfo: ReadonlyMap<string, TracePage>, primary: string): (id: string) => boolean {
    const context = pageInfo.get(primary)?.contextId
    return (id) => id === primary || (context !== undefined && pageInfo.get(id)?.contextId === context)
  }

  /**
   * A page's CSS viewport and the size its content was recorded at in its
   * video. A frame's width/height are CSS pixels; in Chromium its JPEG is the
   * recorded content (other browsers: no recorded size, no crop). The largest
   * JPEG counts, so a late viewport change cannot shrink the video, and one
   * reference frame's ratio gives the viewport, so both axes scale alike.
   */
  private async pageSize(parsed: ParsedTrace, pageId: string): Promise<{ viewport: { width: number; height: number }; recorded?: { width: number; height: number } } | undefined> {
    const frames = parsed.frames.filter((f) => f.pageId === pageId)
    if (frames.length === 0) return undefined
    const cssMax = { width: Math.max(...frames.map((f) => f.width)), height: Math.max(...frames.map((f) => f.height)) }
    if (parsed.metadata.browserName !== 'chromium') return { viewport: cssMax }
    // One readable JPEG per CSS size, trying the next frame of that size when one is not
    const bySize = new Map<string, ScreencastFrame[]>()
    for (const f of frames) {
      const key = `${f.width}x${f.height}`
      const group = bySize.get(key)
      if (group) group.push(f)
      else bySize.set(key, [f])
    }
    const samples: Array<{ css: { width: number; height: number }; jpeg: { width: number; height: number } }> = []
    for (const group of bySize.values()) {
      for (const frame of [...group].reverse()) {
        let jpeg: { width: number; height: number } | undefined
        try { jpeg = jpegSize(await parsed.frameReader.readFrame(frame.sha1)) } catch { /* no image in the trace */ }
        if (jpeg) { samples.push({ css: { width: frame.width, height: frame.height }, jpeg }); break }
      }
    }
    if (samples.length === 0) return { viewport: cssMax }
    const recorded = { width: Math.max(...samples.map((x) => x.jpeg.width)), height: Math.max(...samples.map((x) => x.jpeg.height)) }
    const ref = samples.reduce((a, b) => (b.jpeg.width * b.jpeg.height > a.jpeg.width * a.jpeg.height ? b : a))
    const cssPerPx = ref.css.width / ref.jpeg.width
    return { viewport: { width: recorded.width * cssPerPx, height: recorded.height * cssPerPx }, recorded }
  }

  /**
   * Cuts the `page@<pageId>.webm` videos of the primary page's context into
   * one video and moves the other pages' points, markers, frames and actions
   * onto the primary page, so later stages see one page. Undefined when there
   * is no video for the primary page: the plain video stands.
   */
  private async compositePages(state: PipelineState, traceDir: string, videoPages: ReadonlyArray<string | null> | undefined): Promise<string | undefined> {
    const parsed = state.parsed!
    const videos = findPageVideos(traceDir, videoPages)
    const primary = primaryPageId(parsed.frames, parsed.pages)
    if (!primary || !videos.has(primary)) return undefined

    // Only the primary page's context: another context's video has its own size and story.
    const pageInfo = new Map((parsed.pages ?? []).map((p) => [p.pageId, p]))
    const sameContext = this.sameContextAs(pageInfo, primary)
    const candidates = new Set([...videos.keys()].filter(sameContext))

    const firstFrameMs = new Map<string, number>()
    for (const f of parsed.frames) {
      if (candidates.has(f.pageId) && !firstFrameMs.has(f.pageId)) firstFrameMs.set(f.pageId, f.timestamp as number)
    }
    // Only pages that can come on screen end the video: the primary and pages with actions.
    const showable = new Set([primary, ...parsed.actions.filter((a) => a.pageId && candidates.has(a.pageId) && a.method !== 'close').map((a) => a.pageId!)])
    const durations = new Map([...showable].filter((id) => firstFrameMs.has(id)).map((id) => [id, getVideoDuration(videos.get(id)!) * 1000]))
    const endMs = Math.max(...[...durations].map(([id, d]) => firstFrameMs.get(id)! + d))
    const timeline = buildPageTimeline({
      primaryId: primary,
      pages: parsed.pages ?? [],
      actions: parsed.actions,
      firstFrameMs,
      candidates,
      endMs,
    })
    const onScreen = new Set(timeline.map((s) => s.pageId))
    const startMs = timeline[0]!.startMs
    // Pages of this context that are not in the video must not time it.
    const visibleFrames = parsed.frames.filter((f) => !sameContext(f.pageId) || (onScreen.has(f.pageId) && (f.timestamp as number) >= startMs))
    // A frame at t=0: stages time the video from the first frame, which may come later.
    const lead = findLast(parsed.frames, (f) => f.pageId === timeline[0]!.pageId && (f.timestamp as number) <= startMs)
    if (lead && (lead.timestamp as number) < startMs) {
      visibleFrames.push({ ...lead, timestamp: toMonotonic(startMs) })
      visibleFrames.sort((a, b) => (a.timestamp as number) - (b.timestamp as number))
    }

    // Every page here has frames, so pageSize() returns a size
    const composited = [...new Set([primary, ...onScreen])]
    const pageSizes = new Map<string, { viewport: { width: number; height: number }; recorded?: { width: number; height: number } }>()
    for (const id of composited) pageSizes.set(id, (await this.pageSize(parsed, id))!)
    const primarySize = pageSizes.get(primary)!
    const metadata = { ...parsed.metadata, viewport: primarySize.viewport }
    if (onScreen.size === 1 && onScreen.has(primary) && startMs === firstFrameMs.get(primary)) {
      state.parsed = { ...parsed, metadata, frames: visibleFrames }
      // A page@ video: Playwright's own, padded around the content
      if (primarySize.recorded) state.contentCrop = primarySize.recorded
      return videos.get(primary)!
    }
    // Without a recorded size (not Chromium), a page is taken to fill its video.
    // A JPEG never exceeds its video: Playwright's recorder pads and crops to the size.
    const sizes = new Map([...pageSizes].map(([id, s]) => [id, { viewport: s.viewport, recorded: s.recorded ?? probeResolution(videos.get(id)!) }]))

    const pagesStage = findLast(this.stages, (st) => st.type === 'pages')
    const pagesConfig = pagesStage?.type === 'pages' ? pagesStage.config : {}
    const layouts = computePageLayouts(primary, sizes, pagesConfig)
    // A per-run dir, removed after the render; other stages still write their temp files next to the video
    this.pagesTmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'recast-pages-'))
    const outputPath = path.join(this.pagesTmpDir, 'pages.mp4')
    compositePageVideos({
      primaryId: primary,
      // The primary page too when its own stretch was dropped: popups sit over it
      pages: composited.map((id) => ({ pageId: id, video: videos.get(id)!, startMs: firstFrameMs.get(id)!, layout: layouts.get(id)! })),
      timeline,
      startMs,
      durationMs: endMs - startMs,
      // The primary page's content without padding, so CSS maps to it like a full video
      size: layouts.get(primary)!.crop,
      fps: probeVideoFps(videos.get(primary)!),
      outputPath,
      backdrop: pagesConfig.backdrop,
    })

    const moved = new Set([...onScreen].filter((id) => id !== primary))
    // A page of this context that never comes on screen must not draw over the video
    const offScreen = (id: string | undefined) => id !== undefined && id !== primary && sameContext(id) && !onScreen.has(id)
    const actions = withoutPages(parsed.actions, offScreen).map((a) => {
      const layout = a.pageId && moved.has(a.pageId) ? layouts.get(a.pageId) : undefined
      let mapped = layout && a.point ? { ...a, point: { ...mapPoint(layout, a.point), timestamp: a.point.timestamp } } : a
      if (typeof a.title === 'string') {
        const markerPage = markerPageId(a.title, a.startTime as number, timeline)
        const markerLayout = markerPage && moved.has(markerPage) ? layouts.get(markerPage) : undefined
        if (markerLayout) {
          const title = mapMarkerTitle(a.title, markerLayout, primarySize.viewport)
          if (title !== a.title) mapped = { ...mapped, title }
        }
      }
      // One page from here on: speedUp() counts user actions on the recording page only.
      return a.pageId && moved.has(a.pageId) ? { ...mapped, pageId: primary } : mapped
    })
    state.parsed = {
      ...parsed,
      metadata,
      actions,
      cursorPositions: actions.filter((a) => a.point).map((a) => a.point!),
      // The earliest of these is the video's t=0, which every stage times from.
      frames: visibleFrames.map((f) => (moved.has(f.pageId) ? { ...f, pageId: primary } : f)),
    }
    state.pageTimeline = timeline
    state.pageVideos = composited.map((id) => videos.get(id)!)
    console.log(`  Pages: ${onScreen.size} composited, ${timeline.length - 1} switch(es)`)
    return outputPath
  }

  /**
   * The plain video is video.webm: the first page of the recording context
   * (the fixture's first, else the one with the context's first frame).
   * Other pages of that context are not in it: their frames must not time it,
   * their actions, points and markers must not show over it.
   */
  private firstPageOnly(parsed: ParsedTrace, videoPages: ReadonlyArray<string | null> | undefined): { parsed: ParsedTrace; first?: string; leftOut: boolean } {
    const recording = recordingFrame(parsed.frames).pageId
    if (!recording) return { parsed, leftOut: false }
    const sameContext = this.sameContextAs(new Map((parsed.pages ?? []).map((p) => [p.pageId, p])), recording)
    // By first frame: pages created before tracing come last in parsed.pages
    const first = videoPages?.[0] ?? parsed.frames.find((f) => sameContext(f.pageId))?.pageId ?? recording
    const other = (id: string | undefined) => id !== undefined && id !== first && sameContext(id)
    const kept = withoutPages(parsed.actions, other)
    const leftOut = parsed.actions.some((a) => other(a.pageId) && a.method !== 'close')
    const actions = kept.length < parsed.actions.length
      ? { actions: kept, cursorPositions: kept.filter((a) => a.point).map((a) => a.point!) }
      : {}
    return { parsed: { ...parsed, ...actions, frames: parsed.frames.filter((f) => !other(f.pageId)) }, first, leftOut }
  }

  /** Warns that other pages of the video's context had actions: they are left out. */
  private warnAboutLeftOutPages(videoPages: ReadonlyArray<string | null> | undefined): void {
    const cause = videoPages
      ? 'recastPageVideos listed the pages, but no video of the main page is next to trace.zip: Playwright keeps none with video \'retain-on-failure\' for a passing test, or \'on-first-retry\' before a retry; or the page had no id (warned when the test ran).'
      : 'Add the recastPageVideos fixture (playwright-recast/helpers) to composite them (see the pages() docs).'
    console.warn(`  Pages: other pages of this test had actions, but only one video is used. ${cause}`)
  }

  /** Trace time of the recording's first frame: the video's t=0. */
  private recordingStartMs(parsed: ParsedTrace): number {
    return recordingFrame(parsed.frames).firstFrameMs ?? (parsed.metadata.startTime as number)
  }

  /** Trace time to output video time, as the click and cursor stages map it. */
  private traceToVideoMs(state: PipelineState): (traceMs: number) => number {
    const startMs = this.recordingStartMs(state.parsed!)
    const speed = state.speedMapped
    if (speed && speed.speedSegments.length > 0) {
      const v0 = speed.timeRemap(toMonotonic(startMs))
      return (t) => speed.timeRemap(toMonotonic(t)) - v0
    }
    return (t) => t - startMs
  }

  private buildUrlBarEvents(state: PipelineState, config: UrlBarConfig): UrlBarEvent[] {
    const parsed = state.parsed!
    const recPageId = recordingFrame(parsed.frames).pageId
    const timeline = state.pageTimeline
    const activePage = (t: number): string | undefined =>
      (timeline ? activePageAt(timeline, t) : undefined) ?? recPageId
    const startMs = this.recordingStartMs(parsed)
    const endMs = Math.max(startMs, parsed.metadata.endTime as number)

    const markers: UrlMarker[] = []
    for (const a of state.filtered?.actions ?? parsed.actions) {
      if (typeof a.title !== 'string' || !a.title.startsWith(URL_TITLE_PREFIX)) continue
      try {
        const data = JSON.parse(a.title.slice(URL_TITLE_PREFIX.length)) as { url?: unknown; durationMs?: unknown }
        markers.push({
          startMs: a.startTime as number,
          ...(typeof data.url === 'string' ? { url: data.url } : {}),
          ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
        })
      } catch {
        // skip malformed markers
      }
    }

    const cues = buildUrlBarCues({
      config,
      pageUrls: parsed.pageUrls ?? [],
      activePage,
      pageSwitches: (timeline ?? []).map((s) => s.startMs),
      markers,
      hiddenRanges: (state.filtered?.hiddenRanges ?? []).map((r) => ({ start: r.start as number, end: r.end as number })),
      startMs,
      endMs,
    })
    const toVideo = this.traceToVideoMs(state)
    const durationMs = config.durationMs ?? 3000
    return cues.map((cue) => {
      const videoTimeMs = Math.max(0, Math.round(toVideo(cue.startMs)))
      const markerDuration = markers.find((m) => m.startMs === cue.startMs)?.durationMs
      return cue.endMs !== undefined
        ? { text: cue.text, videoTimeMs, endTimeMs: Math.round(toVideo(cue.endMs)), traceMs: cue.startMs, endTraceMs: cue.endMs }
        : config.show === 'always'
          ? { text: cue.text, videoTimeMs, traceMs: cue.startMs }
          : { text: cue.text, videoTimeMs, endTimeMs: videoTimeMs + (markerDuration ?? durationMs), traceMs: cue.startMs }
    })
  }

  /**
   * Build a video from the trace's screencast JPEG frames as a fallback
   * when no sibling .webm exists. Only invoked from the parse stage when
   * `findSourceVideo()` returned undefined — the happy path with a real
   * recordVideo .webm bypasses this entirely. See issue #6.
   */
  private async assembleFallbackVideo(parsed: ParsedTrace): Promise<string> {
    const pageFrames = selectRecordingPageFrames(parsed.frames)
    if (pageFrames.length === 0) {
      throw new Error(
        'No source video found and the trace contains no screencast frames. ' +
          'Enable `recordVideo` in your Playwright config (use: { video: \'on\' }) ' +
          'so the .webm sits next to trace.zip, or run tests with --trace=on which ' +
          'embeds screencast frames.',
      )
    }
    const dir = this.source.endsWith('.zip')
      ? path.dirname(this.source)
      : this.source
    const tmpDir = path.join(dir, '.recast-screencast-tmp')
    const outputPath = path.join(tmpDir, 'screencast.mp4')
    console.log(`  Source video: assembling from ${pageFrames.length} screencast frames (no sibling .webm)`)
    await assembleVideoFromScreencastFrames({
      frames: pageFrames,
      readFrame: (sha1) => parsed.frameReader.readFrame(sha1),
      tmpDir,
      outputPath,
    })
    return outputPath
  }
}
