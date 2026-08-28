import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { generateVoiceover } from '../../../src/voiceover/voiceover-processor'
import type { TtsProvider } from '../../../src/types/voiceover'
import type { SubtitledTrace } from '../../../src/types/subtitle'

/**
 * The narration track is a concatenation of MP3 files, but cue times were
 * advanced by the durations we *asked* for. Every generated file is longer than
 * that: MPEG-2 frames at 24kHz quantise to 24ms, libmp3lame adds encoder delay
 * and padding, and the `Math.max(0.01, …)` clamp gives even a 1ms gap a ~72ms
 * file. The excess used to accumulate over every cue, so captions ran further
 * and further ahead of the voice — on a real 55-cue screencast, 71ms of drift
 * at the first cue and 3370ms by the last.
 *
 * The fix is that each gap is measured against where the audio actually ends,
 * so one file's excess is absorbed by the next gap instead of compounding.
 * These tests pin that: drift must stay bounded, and must not grow with cue
 * count.
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

/**
 * Where each cue's speech actually begins in the assembled track, measured the
 * way the track is built: cumulative real duration of the concat list.
 */
function measuredSegmentStarts(tmpDir: string): Map<number, number> {
  const files = fs.readFileSync(path.join(tmpDir, 'concat.txt'), 'utf8')
    .split('\n').filter((l) => l.trim() !== '')
    .map((l) => /^file '(.+)'$/.exec(l)![1]!)

  const starts = new Map<number, number>()
  let pos = 0
  for (const file of files) {
    const seg = /^seg-(\d+)\.mp3$/.exec(file)
    if (seg) starts.set(Number(seg[1]), pos)
    pos += durationMs(path.join(tmpDir, file))
  }
  return starts
}

/** Signed caption-minus-audio offset per cue; negative = caption is early. */
async function driftPerCue(cueCount: number, label: string): Promise<number[]> {
  const tmpDir = path.join(TMP_ROOT, label)
  fs.mkdirSync(tmpDir, { recursive: true })
  const trace = makeTrace(cueCount)
  await generateVoiceover(trace, fixedLengthProvider(), tmpDir, undefined, [], FPS)

  const starts = measuredSegmentStarts(tmpDir)
  return trace.subtitles.map((s) => {
    const audioStart = starts.get(s.index)
    if (audioStart === undefined) throw new Error(`no audio for cue ${s.index}`)
    return s.startMs - audioStart
  })
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
}, 300_000)
