import { z } from 'zod'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'
import type { TtsProvider } from '../../types/voiceover.js'
import { analyzeTrace } from '../analyzer.js'
import { writeSrtFile } from '../srt-builder.js'
import { Pipeline } from '../../pipeline/pipeline.js'
import { parseTrace } from '../../parse/trace-parser.js'
import { OpenAIProvider } from '../../voiceover/providers/openai.js'
import { ElevenLabsProvider } from '../../voiceover/providers/elevenlabs.js'

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const StepSchema = z.object({
  id: z.string().describe('Step ID from analyze_trace (e.g. "step-1")'),
  hidden: z.boolean().describe('Whether to hide this step in the output video'),
  voiceover: z.string().optional().describe('Voiceover text for this step (visible steps only)'),
})

const SettingsSchema = z.object({
  ttsProvider: z.enum(['openai', 'elevenlabs', 'none']).optional()
    .describe('TTS provider to use. Default: from server config'),
  voice: z.string().optional()
    .describe('Voice ID (provider-specific). OpenAI: "nova", "alloy", etc. ElevenLabs: voice ID'),
  model: z.string().optional()
    .describe('TTS model. OpenAI: "gpt-4o-mini-tts". ElevenLabs: "eleven_multilingual_v2"'),
  speed: z.number().positive().optional()
    .describe('TTS speech speed multiplier. Default: 1.0'),
  format: z.enum(['mp4', 'webm']).optional()
    .describe('Output video format. Default: "mp4"'),
  resolution: z.enum(['720p', '1080p', '1440p', '4k']).optional()
    .describe('Output resolution. Default: from server config'),
  burnSubtitles: z.boolean().optional()
    .describe('Burn subtitles into the video. Default: true'),
  cursorOverlay: z.boolean().optional()
    .describe('Add animated cursor overlay. Default: true'),
  clickEffect: z.boolean().optional()
    .describe('Add click ripple effects. Default: true'),
  autoZoom: z.boolean().optional()
    .describe('Enable auto-zoom on actions. Default: true'),
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
        'cursor overlay, click effects, and TTS voiceover. Returns the output file path.',
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
        // 4. Parse trace to get callIds for hidden action matching
        // ------------------------------------------------------------------
        const parsed = await parseTrace(tracePath)
        const traceActions = parsed.actions
        parsed.frameReader.dispose()

        // Collect callIds of all actions belonging to hidden steps
        const hiddenCallIds = new Set<string>()
        for (const userStep of steps) {
          if (!userStep.hidden) continue
          const analyzed = stepMap.get(userStep.id)
          if (!analyzed) continue
          for (const idx of analyzed.actionIndices) {
            const action = traceActions[idx]
            if (action) {
              hiddenCallIds.add(action.callId)
            }
          }
        }

        // ------------------------------------------------------------------
        // 5. Build Pipeline
        // ------------------------------------------------------------------
        const format = settings?.format ?? 'mp4'
        const resolution = settings?.resolution ?? config.resolution
        const burnSubtitles = settings?.burnSubtitles ?? true
        const enableCursor = settings?.cursorOverlay ?? true
        const enableClickEffect = settings?.clickEffect ?? true
        const enableAutoZoom = settings?.autoZoom ?? true
        const outputFile = settings?.outputPath
          ? path.resolve(settings.outputPath)
          : path.join(resolvedDir, `demo.${format}`)

        let pipeline = Pipeline.from(tracePath)
          .parse()
          .hideSteps((action) => hiddenCallIds.has(action.callId))
          .speedUp({ duringIdle: 4.0, duringNetworkWait: 2.0, duringNavigation: 2.0 })
          .subtitlesFromSrt(srtPath)
          .textProcessing({ builtins: true })

        if (enableAutoZoom) {
          pipeline = pipeline.autoZoom()
        }

        if (enableCursor) {
          pipeline = pipeline.cursorOverlay()
        }

        if (enableClickEffect) {
          pipeline = pipeline.clickEffect()
        }

        // TTS voiceover
        const ttsProvider = createTtsProvider(config.ttsProvider, config, settings)
        if (ttsProvider) {
          pipeline = pipeline.voiceover(ttsProvider)
        }

        pipeline = pipeline.render({
          format,
          resolution,
          burnSubtitles,
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
            burnSubtitles,
            voiceover: !!ttsProvider,
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
