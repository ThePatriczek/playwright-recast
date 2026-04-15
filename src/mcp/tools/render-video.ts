import { z } from 'zod'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'
import type { TtsProvider } from '../../types/voiceover.js'
import type { TraceAction } from '../../types/trace.js'
import { toMonotonic } from '../../types/trace.js'
import { analyzeTrace } from '../analyzer.js'
import { writeSrtFile } from '../srt-builder.js'
import { Pipeline } from '../../pipeline/pipeline.js'
import { parseTrace } from '../../parse/trace-parser.js'
import { OpenAIProvider } from '../../voiceover/providers/openai.js'
import { ElevenLabsProvider } from '../../voiceover/providers/elevenlabs.js'
import { PollyProvider } from '../../voiceover/providers/polly.js'

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const StepSchema = z.object({
  id: z.string().describe('Step ID from analyze_trace (e.g. "step-1")'),
  hidden: z.boolean().describe('Whether to hide this step in the output video'),
  voiceover: z.string().optional().describe('Voiceover text for this step (visible steps only)'),
})

const SettingsSchema = z.object({
  ttsProvider: z.enum(['openai', 'elevenlabs', 'polly', 'none']).optional()
    .describe('TTS provider to use. Default: from server config'),
  voice: z.string().optional()
    .describe('Voice ID (provider-specific). OpenAI: "nova", "alloy", etc. ElevenLabs: voice ID. Polly: "Joanna", "Matthew", "Ruth", etc.'),
  model: z.string().optional()
    .describe('TTS model. OpenAI: "gpt-4o-mini-tts". ElevenLabs: "eleven_multilingual_v2". Polly: engine ("standard"|"neural"|"long-form"|"generative")'),
  speed: z.number().positive().optional()
    .describe('TTS speech speed multiplier. Default: 1.0'),
  format: z.enum(['mp4', 'webm']).optional()
    .describe('Output video format. Default: "mp4"'),
  resolution: z.enum(['720p', '1080p', '1440p', '4k']).optional()
    .describe('Output resolution. Default: "4k"'),
  fps: z.number().int().positive().optional()
    .describe('Output FPS. Default: 120'),
  burnSubtitles: z.boolean().optional()
    .describe('Burn subtitles into the video. Default: true'),
  cursorOverlay: z.boolean().optional()
    .describe('Add animated cursor overlay. Default: true'),
  clickEffect: z.boolean().optional()
    .describe('Add click ripple effects with sound. Default: true'),
  autoZoom: z.boolean().optional()
    .describe('Enable auto-zoom on actions. Default: true'),
  textHighlight: z.boolean().optional()
    .describe('Enable text highlight overlays from report.json. Default: true'),
  introPath: z.string().optional()
    .describe('Path to intro video file (.mov/.mp4) to prepend'),
  outroPath: z.string().optional()
    .describe('Path to outro video file (.mov/.mp4) to append'),
  backgroundMusicPath: z.string().optional()
    .describe('Path to background music file (.mp3/.wav). Default: from server config'),
  backgroundMusicVolume: z.number().min(0).max(1).optional()
    .describe('Background music volume 0.0-1.0. Default: 0.15'),
  outputPath: z.string().optional()
    .describe('Output file path. Default: <traceDir>/demo.<format>'),
}).optional()

const InputSchema = z.object({
  traceDir: z.string().describe('Directory containing trace.zip (returned by record_session)'),
  steps: z.array(StepSchema).min(1)
    .describe('Steps from analyze_trace, with hidden flags and voiceover text filled in'),
  settings: SettingsSchema,
})

// ---------------------------------------------------------------------------
// Resolution-aware subtitle style
// ---------------------------------------------------------------------------

function getSubtitleStyle(resolution: string) {
  // Base values tuned for 4k, scale down for lower resolutions
  const scale = resolution === '4k' ? 1.0
    : resolution === '1440p' ? 0.75
    : resolution === '1080p' ? 0.5
    : 0.375 // 720p

  return {
    fontFamily: 'Arial',
    fontSize: Math.round(96 * scale),
    primaryColor: '#1a1a1a',
    backgroundColor: '#FFFFFF',
    backgroundOpacity: 0.75,
    padding: Math.round(40 * scale),
    bold: true,
    position: 'bottom' as const,
    marginVertical: Math.round(100 * scale),
    marginHorizontal: Math.round(200 * scale),
    chunkOptions: { maxCharsPerLine: 55 },
  }
}

// ---------------------------------------------------------------------------
// TTS provider factory
// ---------------------------------------------------------------------------

function createTtsProvider(
  providerName: RecastMcpConfig['ttsProvider'],
  config: RecastMcpConfig,
  settings?: z.infer<typeof SettingsSchema>,
): TtsProvider | null {
  const provider = settings?.ttsProvider ?? providerName

  if (provider === 'none') return null

  if (provider === 'openai') {
    const apiKey = config.openaiApiKey
    if (!apiKey) return null
    return OpenAIProvider({
      apiKey,
      voice: settings?.voice ?? config.ttsVoice,
      model: settings?.model ?? config.ttsModel,
      speed: settings?.speed,
    })
  }

  if (provider === 'elevenlabs') {
    const apiKey = config.elevenlabsApiKey
    if (!apiKey) return null
    return ElevenLabsProvider({
      apiKey,
      voiceId: settings?.voice ?? config.ttsVoice,
      modelId: settings?.model ?? config.ttsModel,
    })
  }

  if (provider === 'polly') {
    // Credentials are resolved lazily by the AWS SDK default chain
    // (env vars, shared config, IAM role on EC2/ECS/Lambda).
    const engine = (settings?.model ?? config.pollyEngine) as
      'standard' | 'neural' | 'long-form' | 'generative'
    return PollyProvider({
      region: config.awsRegion,
      voice: settings?.voice ?? config.ttsVoice,
      engine,
    })
  }

  return null
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerRenderVideo(server: McpServer, config: RecastMcpConfig): void {
  server.registerTool(
    'render_video',
    {
      title: 'Render Demo Video',
      description:
        'Renders a polished demo video from a Playwright trace recording. ' +
        'Accepts steps (from analyze_trace) with voiceover text and hidden flags. ' +
        'Generates SRT subtitles, hides specified steps, applies speed-up, auto-zoom, ' +
        'cursor overlay, click effects with sound, text highlights, and TTS voiceover. ' +
        'Supports intro/outro video overlays. Returns the output file path.',
      inputSchema: InputSchema,
    },
    async ({ traceDir, steps, settings }) => {
      const resolvedDir = path.resolve(traceDir)
      const tracePath = path.join(resolvedDir, 'trace.zip')

      if (!fs.existsSync(tracePath)) {
        return {
          content: [{ type: 'text' as const, text: `Trace not found: ${tracePath}` }],
          isError: true,
        }
      }

      try {
        // ------------------------------------------------------------------
        // 1. Re-analyze trace to get AnalyzedStep[] with actionIndices
        // ------------------------------------------------------------------
        const analysis = await analyzeTrace(resolvedDir)
        const analyzedSteps = analysis.steps
        analysis.dispose()

        // Build a map: step.id -> AnalyzedStep (for action index lookups)
        const stepMap = new Map(analyzedSteps.map((s) => [s.id, s]))

        // ------------------------------------------------------------------
        // 2. Merge user-provided hidden/voiceover into analyzed steps
        //    to build the SRT input
        // ------------------------------------------------------------------
        const userStepMap = new Map(steps.map((s) => [s.id, s]))

        const srtSteps = analyzedSteps.map((analyzed) => {
          const userStep = userStepMap.get(analyzed.id)
          return {
            id: analyzed.id,
            hidden: userStep?.hidden ?? analyzed.hidden,
            startTimeMs: analyzed.startTimeMs,
            endTimeMs: analyzed.endTimeMs,
            voiceover: userStep?.voiceover,
          }
        })

        // ------------------------------------------------------------------
        // 3. Write SRT file from visible steps with voiceover text
        // ------------------------------------------------------------------
        const srtPath = writeSrtFile(resolvedDir, srtSteps)

        // ------------------------------------------------------------------
        // 4. Parse trace for metadata + build hidden time ranges
        // ------------------------------------------------------------------
        const parsed = await parseTrace(tracePath)
        parsed.frameReader.dispose()

        // Build hidden time ranges from user-marked hidden steps.
        // Merge overlapping/adjacent ranges so there are no tiny visible gaps
        // between consecutive hidden steps (e.g., login flow).
        const rawHidden: Array<{ startMs: number; endMs: number }> = []
        for (const userStep of steps) {
          if (!userStep.hidden) continue
          const analyzed = stepMap.get(userStep.id)
          if (!analyzed) continue
          rawHidden.push({
            startMs: analyzed.startTimeMs,
            endMs: analyzed.endTimeMs,
          })
        }
        rawHidden.sort((a, b) => a.startMs - b.startMs)

        // Merge: if gap between consecutive hidden ranges is < 2s, merge them
        const hiddenTimeRanges: Array<{ startMs: number; endMs: number }> = []
        for (const range of rawHidden) {
          const last = hiddenTimeRanges[hiddenTimeRanges.length - 1]
          if (last && range.startMs <= last.endMs + 2000) {
            last.endMs = Math.max(last.endMs, range.endMs)
          } else {
            hiddenTimeRanges.push({ ...range })
          }
        }

        // ------------------------------------------------------------------
        // 5. Build Pipeline (matching battle-tested demo pipeline config)
        // ------------------------------------------------------------------
        const format = settings?.format ?? 'mp4'
        const resolution = settings?.resolution ?? config.resolution
        const fps = settings?.fps ?? config.fps
        const burnSubtitles = settings?.burnSubtitles ?? true
        const enableCursor = settings?.cursorOverlay ?? true
        const enableClickEffect = settings?.clickEffect ?? true
        const enableAutoZoom = settings?.autoZoom ?? true
        const enableTextHighlight = settings?.textHighlight ?? true
        const outputFile = settings?.outputPath
          ? path.resolve(settings.outputPath)
          : path.join(resolvedDir, `demo.${format}`)

        // Resolve intro/outro: settings override > config defaults
        const introResolved = settings?.introPath
          ? path.resolve(settings.introPath)
          : config.introPath ? path.resolve(config.introPath) : ''
        const outroResolved = settings?.outroPath
          ? path.resolve(settings.outroPath)
          : config.outroPath ? path.resolve(config.outroPath) : ''

        // ------------------------------------------------------------------
        // 5. Read DOM-tracked actions and build synthetic TraceActions
        // ------------------------------------------------------------------
        const recordedActionsPath = path.join(resolvedDir, '_recorded-actions.json')
        let syntheticActions: TraceAction[] = []

        if (fs.existsSync(recordedActionsPath)) {
          const recorded: Array<{
            method: string
            selector: string
            value?: string
            x?: number
            y?: number
            timestamp: number
          }> = JSON.parse(fs.readFileSync(recordedActionsPath, 'utf-8'))

          if (recorded.length > 0) {
            // Align timestamps to trace monotonic time.
            // Only inject actions from VISIBLE steps — hidden actions would
            // produce click sounds/effects in the intro/cut periods.
            const traceStartAbs = parsed.metadata.startTime as number
            const domBaseMs = recorded[0]!.timestamp

            const allSynthetic: TraceAction[] = recorded.map((r, i) => ({
              callId: `recorded-${i}`,
              title: '',
              class: 'Frame',
              method: r.method,
              params: {
                selector: r.selector,
                ...(r.value != null ? { value: r.value } : {}),
                ...(r.method === 'goto' ? { url: r.value ?? '' } : {}),
              },
              startTime: toMonotonic(traceStartAbs + (r.timestamp - domBaseMs)),
              endTime: toMonotonic(traceStartAbs + (r.timestamp - domBaseMs) + 100),
              point: r.x != null && r.y != null
                ? { x: r.x, y: r.y, timestamp: toMonotonic(traceStartAbs + (r.timestamp - domBaseMs)) }
                : undefined,
            }))

            // Filter: only keep actions from visible time ranges
            syntheticActions = allSynthetic.filter((action) => {
              const relTimeMs = (action.startTime as number) - traceStartAbs
              return !hiddenTimeRanges.some((h) => relTimeMs >= h.startMs && relTimeMs <= h.endMs)
            })
          }
        }

        // ------------------------------------------------------------------
        // 6. Build Pipeline with injected actions
        // ------------------------------------------------------------------
        let pipeline = Pipeline.from(tracePath)
          .parse()

        // Inject DOM-tracked actions so hideSteps/clickEffect/autoZoom work
        if (syntheticActions.length > 0) {
          pipeline = pipeline.injectActions(syntheticActions)
        }

        // Build speed segments: ONLY visible periods get segments.
        // Hidden periods have NO segment → renderer cuts them out completely.
        //
        // IMPORTANT: speedUp({ segments }) expects times RELATIVE to video start (0-based).
        // The speed processor adds baseline (first frame timestamp) internally.
        // Analyzer step times are already relative (from 0), so use them directly.
        const traceDurationMs = (parsed.metadata.endTime as number) - (parsed.metadata.startTime as number)

        const sortedHidden = [...hiddenTimeRanges].sort((a, b) => a.startMs - b.startMs)

        const speedSegments: Array<{ startMs: number; endMs: number; speed: number }> = []
        let cursor = 0

        for (const hidden of sortedHidden) {
          if (cursor < hidden.startMs) {
            speedSegments.push({ startMs: cursor, endMs: hidden.startMs, speed: 1.0 })
          }
          // Hidden range: maximum speed → renderer outputs ~0 frames for this period.
          // Must include a segment (not skip) because the renderer only applies speed
          // processing when it detects at least one non-1x segment.
          speedSegments.push({ startMs: hidden.startMs, endMs: hidden.endMs, speed: 9999 })
          cursor = hidden.endMs
        }
        if (cursor < traceDurationMs) {
          speedSegments.push({ startMs: cursor, endMs: traceDurationMs, speed: 1.0 })
        }

        pipeline = pipeline
          .speedUp({ segments: speedSegments })
          .subtitlesFromSrt(srtPath)
          .textProcessing({ builtins: true })

        // Auto-zoom: subtle, only input actions get zoom, clicks stay 1:1
        if (enableAutoZoom) {
          pipeline = pipeline.autoZoom({
            clickLevel: 1.0,
            inputLevel: 1.2,
            idleLevel: 1.0,
            centerBias: 0.3,
          })
        }

        if (enableCursor) {
          pipeline = pipeline.cursorOverlay()
        }

        // Click effect with bundled click sound
        if (enableClickEffect) {
          pipeline = pipeline.clickEffect({ sound: config.clickSound || undefined })
        }

        // Text highlight overlays from report.json
        if (enableTextHighlight) {
          pipeline = pipeline.textHighlight()
        }

        // Intro/outro video overlays (from settings or config defaults)
        if (introResolved && fs.existsSync(introResolved)) {
          pipeline = pipeline.intro({ path: introResolved })
        }
        if (outroResolved && fs.existsSync(outroResolved)) {
          pipeline = pipeline.outro({ path: outroResolved })
        }

        // TTS voiceover
        const ttsProvider = createTtsProvider(config.ttsProvider, config, settings)
        if (ttsProvider) {
          pipeline = pipeline.voiceover(ttsProvider)
        }

        // Background music (with auto-ducking during voiceover)
        const bgMusicPath = settings?.backgroundMusicPath
          ? path.resolve(settings.backgroundMusicPath)
          : config.backgroundMusicPath ? path.resolve(config.backgroundMusicPath) : ''
        if (bgMusicPath && fs.existsSync(bgMusicPath)) {
          pipeline = pipeline.backgroundMusic({
            path: bgMusicPath,
            volume: settings?.backgroundMusicVolume ?? config.backgroundMusicVolume,
            ducking: true,
            duckLevel: 0.05,
            fadeOutMs: 3000,
            loop: true,
          })
        }

        // Render with full subtitle styling
        pipeline = pipeline.render({
          format,
          resolution,
          fps,
          burnSubtitles,
          subtitleStyle: getSubtitleStyle(resolution),
        })

        // ------------------------------------------------------------------
        // 6. Execute pipeline
        // ------------------------------------------------------------------
        await pipeline.toFile(outputFile)

        // Dispose TTS provider if created
        if (ttsProvider) {
          await ttsProvider.dispose()
        }

        // ------------------------------------------------------------------
        // 7. Build result metadata
        // ------------------------------------------------------------------
        const stat = fs.statSync(outputFile)
        const visibleSteps = steps.filter((s) => !s.hidden)
        const voiceoverSteps = visibleSteps.filter((s) => s.voiceover && s.voiceover.trim().length > 0)

        const result = {
          outputPath: outputFile,
          format,
          resolution,
          fps,
          fileSizeBytes: stat.size,
          fileSizeMb: Math.round((stat.size / (1024 * 1024)) * 100) / 100,
          totalSteps: steps.length,
          visibleSteps: visibleSteps.length,
          hiddenSteps: steps.filter((s) => s.hidden).length,
          voiceoverSteps: voiceoverSteps.length,
          srtPath,
          ttsProvider: ttsProvider?.name ?? 'none',
          features: {
            autoZoom: enableAutoZoom,
            cursorOverlay: enableCursor,
            clickEffect: enableClickEffect,
            textHighlight: enableTextHighlight,
            burnSubtitles,
            voiceover: !!ttsProvider,
            intro: !!(introResolved && fs.existsSync(introResolved)),
            outro: !!(outroResolved && fs.existsSync(outroResolved)),
          },
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Render failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )
}
