import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { generateVoiceover } from '../../../src/voiceover/voiceover-processor'
import { probeAudioFormat, planAudioConcat } from '../../../src/voiceover/audio-format'
import type { TtsProvider } from '../../../src/types/voiceover'
import type { SubtitledTrace } from '../../../src/types/subtitle'

let tmpDir: string

/** Real 44.1kHz mono mp3 — a stand-in for a provider like ElevenLabs, which
 *  disagrees with generateSilence()'s old hardcoded 24kHz default. */
function makeTtsFixture(outPath: string, durationSec: number): void {
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${durationSec}`,
    '-ar', '44100', '-ac', '1',
    '-c:a', 'libmp3lame', '-b:a', '128k',
    outPath,
  ])
}

function fixedFormatProvider(): TtsProvider {
  let i = 0
  return {
    name: 'fixed-44100-mono',
    async synthesize(texts, options) {
      const dir = options?.workDir ?? tmpDir
      fs.mkdirSync(dir, { recursive: true })
      return texts.map(() => {
        const p = path.join(dir, `tts-${i++}.mp3`)
        makeTtsFixture(p, 1)
        return { path: p, durationMs: 0, format: { sampleRate: 44100, channels: 1, codec: 'mp3' } }
      })
    },
    async isAvailable() { return true },
    async dispose() {},
  }
}

function makeTrace(): SubtitledTrace {
  // Gaps before and between subtitles, plus windows longer than the 1s
  // fixture audio, force generateSilence() to run for both the lead-in gap
  // and the pad after each segment.
  const subs = [
    { index: 1, startMs: 500, endMs: 3000, text: 'one', ttsText: undefined as string | undefined },
    { index: 2, startMs: 5000, endMs: 8000, text: 'two', ttsText: undefined as string | undefined },
  ]
  return { subtitles: subs } as unknown as SubtitledTrace
}

describe('generateVoiceover — silence matches TTS sample rate (#22)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-vo-silence-rate-'))
  })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('generates silence at the provider rate, so a 44.1kHz mono narration stays on -c copy', async () => {
    const trace = makeTrace()
    const workDir = path.join(tmpDir, 'run')
    await generateVoiceover(trace, fixedFormatProvider(), workDir, undefined, undefined, 25)

    const segmentFiles = fs.readdirSync(workDir)
      .filter((f) => f.endsWith('.mp3') && f !== 'voiceover.mp3')
      .map((f) => path.join(workDir, f))

    // Sanity: this run actually exercised generated silence, not just TTS.
    expect(segmentFiles.some((f) => path.basename(f).startsWith('silence-'))).toBe(true)
    expect(segmentFiles.some((f) => path.basename(f).startsWith('pad-'))).toBe(true)

    const formats = segmentFiles.map((f) => probeAudioFormat(f))
    expect(formats.every((f) => f !== null)).toBe(true)
    for (const f of formats) {
      expect(f).toEqual({ sampleRate: 44100, channels: 1 })
    }

    // The real point: fed through the same planner the processor uses,
    // matching formats mean the -c copy path, not a downsampling re-encode.
    expect(planAudioConcat(formats)).toEqual({ normalise: false })
  })
})
