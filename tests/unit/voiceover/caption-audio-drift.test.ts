import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { generateVoiceover } from '../../../src/voiceover/voiceover-processor'
import { wavData, wavSampleCount } from '../../../src/voiceover/wav'
import type { TtsProvider } from '../../../src/types/voiceover'
import type { SubtitledTrace } from '../../../src/types/subtitle'

/**
 * Captions must start where their speech starts in the narration track, also
 * after many cues. Onsets are found in the track's PCM samples, so even 10 ms
 * gaps count.
 */

const SAMPLE_RATE = 24_000
const CHANNELS = 1
const SPEECH_MS = 1000
const FPS = 25
/** Cue windows far shorter than the audio, so every cue takes the overflow
 *  path and leaves a small gap behind — the shape that produced the drift. */
const WINDOW_MS = 100
const GAP_MS = 10

let TMP_ROOT: string
let SPEECH_MP3: Buffer

function durationMs(file: string): number {
  return Number(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]).toString().trim()) * 1000
}

/** A provider handing back a fixed-length clip in the TTS format. */
function fixedLengthProvider(): TtsProvider {
  return {
    name: 'fixed-length',
    async synthesize(texts: string[], options) {
      const dir = options?.workDir ?? TMP_ROOT
      fs.mkdirSync(dir, { recursive: true })
      return texts.map(() => {
        const filePath = path.join(dir, `tts-${crypto.randomUUID()}.mp3`)
        fs.writeFileSync(filePath, SPEECH_MP3)
        return {
          path: filePath,
          durationMs: SPEECH_MS,
          format: { sampleRate: SAMPLE_RATE, channels: CHANNELS, codec: 'mp3' },
        }
      })
    },
    async isAvailable() { return true },
    async dispose() {},
  }
}

function makeTrace(cueCount: number): SubtitledTrace {
  const subtitles = Array.from({ length: cueCount }, (_, k) => ({
    index: k + 1,
    startMs: k * (WINDOW_MS + GAP_MS),
    endMs: k * (WINDOW_MS + GAP_MS) + WINDOW_MS,
    text: `line ${k + 1}`,
    ttsText: undefined as string | undefined,
  }))
  return { subtitles } as unknown as SubtitledTrace
}

/** Silent runs in the track, in ms: [start, end) of each run of at least 5 ms below a small amplitude. */
function silentRuns(trackPath: string): Array<[number, number]> {
  const { offset, bytes, blockAlign } = wavData(trackPath)
  const pcm = fs.readFileSync(trackPath).subarray(offset, offset + bytes)
  const samples = bytes / blockAlign
  const minRun = Math.round(SAMPLE_RATE * 0.005)
  const runs: Array<[number, number]> = []
  let runStart = -1
  for (let i = 0; i <= samples; i++) {
    const quiet = i < samples && Math.abs(pcm.readInt16LE(i * blockAlign)) < 50
    if (quiet && runStart < 0) runStart = i
    if (!quiet && runStart >= 0) {
      if (i - runStart >= minRun) runs.push([(runStart * 1000) / SAMPLE_RATE, (i * 1000) / SAMPLE_RATE])
      runStart = -1
    }
  }
  return runs
}

/** Where speech starts in the track, in ms: at 0 or at the end of a silent run, except at the end of the track. */
function speechOnsets(trackPath: string): number[] {
  const runs = silentRuns(trackPath)
  const endMs = (wavSampleCount(trackPath) * 1000) / SAMPLE_RATE
  const onsets = runs.map(([, end]) => end).filter((t) => t < endMs - 1)
  return runs[0]?.[0] === 0 ? onsets : [0, ...onsets]
}

/** Signed caption-minus-audio offset per cue; negative = caption is early. */
async function driftPerCue(cueCount: number, label: string): Promise<number[]> {
  const tmpDir = path.join(TMP_ROOT, label)
  fs.mkdirSync(tmpDir, { recursive: true })
  const trace = makeTrace(cueCount)
  await generateVoiceover(trace, fixedLengthProvider(), tmpDir, undefined, [], FPS)

  const onsets = speechOnsets(path.join(tmpDir, 'voiceover.wav'))
  if (onsets.length !== trace.subtitles.length) throw new Error(`${onsets.length} onsets for ${trace.subtitles.length} cues`)
  return trace.subtitles.map((s, i) => s.startMs - onsets[i]!)
}

describe('captions stay aligned with the narration track', () => {
  beforeAll(() => {
    TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-caption-drift-'))
    const speech = path.join(TMP_ROOT, 'speech.mp3')
    execFileSync('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi',
      '-i', `sine=frequency=440:sample_rate=${SAMPLE_RATE}:duration=${SPEECH_MS / 1000}`,
      '-ac', String(CHANNELS), '-c:a', 'libmp3lame', '-q:a', '9', speech,
    ], { stdio: 'pipe' })
    SPEECH_MP3 = fs.readFileSync(speech)
  })

  afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  })

  it('keeps every cue within a frame or two of its audio', async () => {
    const drift = await driftPerCue(30, 'bounded')
    const worst = Math.max(...drift.map(Math.abs))
    expect(
      worst,
      `worst drift ${worst.toFixed(0)}ms across 30 cues; per-cue drift: `
      + drift.map((d) => d.toFixed(0)).join(', '),
    ).toBeLessThan(100)
  })

  it('does not accumulate drift as cues go on', async () => {
    // The signature of the bug: the last cue drifts ~N times the first.
    const drift = await driftPerCue(30, 'accumulation')
    const firstFive = Math.max(...drift.slice(0, 5).map(Math.abs))
    const lastFive = Math.max(...drift.slice(-5).map(Math.abs))
    expect(
      lastFive,
      `drift grew from ${firstFive.toFixed(0)}ms at the start to `
      + `${lastFive.toFixed(0)}ms at the end`,
    ).toBeLessThan(firstFive + 50)
  })

  it('holds alignment at 4x the cue count', async () => {
    // Same bound at 120 cues as at 30 — the error must not scale with length.
    const drift = await driftPerCue(120, 'long')
    const worst = Math.max(...drift.map(Math.abs))
    expect(worst, `worst drift ${worst.toFixed(0)}ms across 120 cues`).toBeLessThan(100)
  })

  it('ends each spokenEndMs where its speech ends in the track', async () => {
    const tmpDir = path.join(TMP_ROOT, 'spoken-end')
    fs.mkdirSync(tmpDir, { recursive: true })
    const { voiceover } = await generateVoiceover(makeTrace(10), fixedLengthProvider(), tmpDir, undefined, [], FPS)
    const runs = silentRuns(voiceover.audioTrackPath)
    for (const e of voiceover.entries) {
      // The first silence after the cue's own speech starts
      const end = runs.find(([start]) => start > e.outputStartMs + SPEECH_MS / 2)?.[0] ?? (wavSampleCount(voiceover.audioTrackPath) * 1000) / SAMPLE_RATE
      expect(Math.abs(e.spokenEndMs! - end)).toBeLessThan(40)
    }
  })

  /** Speech onsets in `file`, in ms: where each silence of 0.3 s or more ends, except at the end of the file. */
  function onsetsIn(file: string): number[] {
    const res = spawnSync('ffmpeg', ['-i', file, '-af', 'silencedetect=noise=-35dB:d=0.3', '-f', 'null', '-'], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    const endMs = durationMs(file)
    return [...res.stderr.matchAll(/silence_end: ([\d.]+)/g)]
      .map((m) => Number(m[1]) * 1000)
      .filter((t) => t < endMs - 50)
  }

  /** 40 cues, 3 s apart, each 2 s window; cue 1 starts after a lead so its onset ends a silence. */
  const spacedCues = () => Array.from({ length: 40 }, (_, k) => ({
    index: k + 1, startMs: 500 + k * 3000, endMs: 500 + k * 3000 + 2000, text: `line ${k + 1}`,
  }))

  it('places speech in the assembled track where the cues are', async () => {
    // In the track itself: summed file durations cannot show join errors
    const tmpDir = path.join(TMP_ROOT, 'assembled')
    fs.mkdirSync(tmpDir, { recursive: true })
    const { voiceover } = await generateVoiceover({ subtitles: spacedCues() } as unknown as SubtitledTrace, fixedLengthProvider(), tmpDir, undefined, [], FPS)
    const onsets = onsetsIn(voiceover.audioTrackPath)
    // The sine has no pauses: one onset per cue, in order.
    expect(onsets).toHaveLength(40)
    const late = voiceover.entries.map((e, i) => Math.round(onsets[i]! - e.outputStartMs))
    expect(Math.max(...late.map(Math.abs)), `speech minus cue start per cue: ${late.join(', ')}`).toBeLessThan(80)
  })

  it('keeps the timing with WAV segments at different rates', async () => {
    // A provider may return any codec, at mixed rates
    const tmpDir = path.join(TMP_ROOT, 'wav-rates')
    fs.mkdirSync(tmpDir, { recursive: true })
    const wav = (rate: number) => {
      const file = path.join(TMP_ROOT, `speech-${rate}.wav`)
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=1`, '-c:a', 'pcm_s16le', file])
      return fs.readFileSync(file)
    }
    const clips = [wav(24_000), wav(16_000)]
    let n = 0
    const provider: TtsProvider = {
      name: 'wav',
      async synthesize(texts, options) {
        return texts.map(() => {
          const filePath = path.join(options?.workDir ?? TMP_ROOT, `tts-${crypto.randomUUID()}.wav`)
          fs.writeFileSync(filePath, clips[n++ % 2]!)
          return { path: filePath, durationMs: 1000, format: { sampleRate: 24_000, channels: 1, codec: 'pcm' } }
        })
      },
      async isAvailable() { return true },
      async dispose() {},
    }
    const { voiceover } = await generateVoiceover({ subtitles: spacedCues().slice(0, 10) } as unknown as SubtitledTrace, provider, tmpDir, undefined, [], FPS)
    const onsets = onsetsIn(voiceover.audioTrackPath)
    expect(onsets).toHaveLength(10)
    const late = voiceover.entries.map((e, i) => Math.round(onsets[i]! - e.outputStartMs))
    expect(Math.max(...late.map(Math.abs)), `speech minus cue start per cue: ${late.join(', ')}`).toBeLessThan(80)
  })
}, 300_000)
