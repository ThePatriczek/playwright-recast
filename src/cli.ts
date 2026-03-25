#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { Pipeline as Recast } from './pipeline/pipeline'

const help = `
playwright-recast — Convert Playwright traces to polished demo videos

USAGE
  playwright-recast --input <trace-dir-or-zip> [options]

OPTIONS
  -i, --input          Trace directory or zip path (required)
  -o, --output         Output file path (default: ./recast-output.mp4)
      --srt            External SRT subtitle file path
      --speed-idle     Speed for idle periods (default: 3.0)
      --speed-action   Speed for user actions (default: 1.0)
      --speed-network  Speed for network waits (default: 2.0)
      --no-speed       Disable speed processing
      --provider       TTS provider: openai | elevenlabs | none (default: none)
      --voice          Voice ID for TTS provider
      --model          Model ID for TTS provider
      --tts-speed      TTS speech speed multiplier
      --format         Output format: mp4 | webm (default: mp4)
      --resolution     Output resolution: 720p | 1080p (default: 1080p)
      --burn-subs      Burn subtitles into video
  -h, --help           Show this help message

EXAMPLES
  playwright-recast -i ./test-results -o demo.mp4
  playwright-recast -i trace.zip --speed-idle 4 --burn-subs
  playwright-recast -i ./traces --srt narration.srt --provider openai --voice nova
`.trim()

function fatal(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      srt: { type: 'string' },
      'speed-idle': { type: 'string' },
      'speed-action': { type: 'string' },
      'speed-network': { type: 'string' },
      'no-speed': { type: 'boolean', default: false },
      provider: { type: 'string' },
      voice: { type: 'string' },
      model: { type: 'string' },
      'tts-speed': { type: 'string' },
      format: { type: 'string' },
      resolution: { type: 'string' },
      'burn-subs': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values.help) {
    console.log(help)
    process.exit(0)
  }

  const input = values.input
  if (!input) {
    fatal('--input / -i is required. Use --help for usage information.')
  }

  const output = values.output ?? './recast-output.mp4'
  const format = (values.format as 'mp4' | 'webm') ?? 'mp4'
  const resolution = (values.resolution as '720p' | '1080p') ?? '1080p'
  const burnSubtitles = values['burn-subs'] ?? false

  // Build the pipeline
  let pipeline = Recast.from(input).parse()

  // Speed processing
  if (!values['no-speed']) {
    const speedIdle = values['speed-idle'] ? Number(values['speed-idle']) : 3.0
    const speedAction = values['speed-action'] ? Number(values['speed-action']) : 1.0
    const speedNetwork = values['speed-network'] ? Number(values['speed-network']) : 2.0

    if (Number.isNaN(speedIdle)) fatal('--speed-idle must be a number')
    if (Number.isNaN(speedAction)) fatal('--speed-action must be a number')
    if (Number.isNaN(speedNetwork)) fatal('--speed-network must be a number')

    pipeline = pipeline.speedUp({
      duringIdle: speedIdle,
      duringUserAction: speedAction,
      duringNetworkWait: speedNetwork,
    })
  }

  // Subtitles
  if (values.srt) {
    pipeline = pipeline.subtitlesFromSrt(values.srt)
  } else {
    pipeline = pipeline.subtitles((action) => action.docString ?? action.text)
  }

  // Voiceover
  const providerName = values.provider ?? 'none'
  if (providerName !== 'none') {
    const ttsSpeed = values['tts-speed'] ? Number(values['tts-speed']) : undefined
    if (values['tts-speed'] && Number.isNaN(ttsSpeed)) {
      fatal('--tts-speed must be a number')
    }

    if (providerName === 'openai') {
      const { OpenAIProvider } = await import('./voiceover/providers/openai')
      pipeline = pipeline.voiceover(
        OpenAIProvider({
          voice: values.voice,
          model: values.model,
          speed: ttsSpeed,
        }),
      )
    } else if (providerName === 'elevenlabs') {
      const { ElevenLabsProvider } = await import('./voiceover/providers/elevenlabs')
      pipeline = pipeline.voiceover(
        ElevenLabsProvider({
          voiceId: values.voice,
          modelId: values.model,
        }),
      )
    } else {
      fatal(`Unknown provider: ${providerName}. Use openai, elevenlabs, or none.`)
    }
  }

  // Render
  pipeline = pipeline.render({
    format,
    resolution,
    burnSubtitles,
  })

  // Execute
  console.log(`Processing trace: ${input}`)
  console.log(`Output: ${output} (${format}, ${resolution})`)

  await pipeline.toFile(output)

  console.log(`Done! Video saved to: ${output}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Fatal error: ${message}`)
  process.exit(1)
})
