import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { generateVoiceover } from '../../../src/voiceover/voiceover-processor'
import type { TtsProvider } from '../../../src/types/voiceover'
import type { SubtitledTrace } from '../../../src/types/subtitle'

const TMP_ROOT = path.join(os.tmpdir(), `recast-vo-freezes-test-${process.pid}`)

function makeSineBuffer(durationSec: number): Buffer {
  fs.mkdirSync(TMP_ROOT, { recursive: true })
  const out = path.join(
    TMP_ROOT,
    `sine-${durationSec}-${Math.random().toString(36).slice(2)}.mp3`,
  )
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `sine=frequency=440:sample_rate=44100:duration=${durationSec}`,
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k',
    out,
  ])
  const buf = fs.readFileSync(out)
  fs.rmSync(out)
  return buf
}

function makeProvider(buffers: Buffer[]): TtsProvider {
  let i = 0
  return {
    name: 'fake-freezes',
    async synthesize(texts, options) {
      const dir = options?.workDir ?? TMP_ROOT
      fs.mkdirSync(dir, { recursive: true })
      return texts.map(() => {
        const data = buffers[i++ % buffers.length]!
        const filePath = path.join(dir, `fake-${crypto.randomUUID()}.mp3`)
        fs.writeFileSync(filePath, data)
        return {
          path: filePath,
          durationMs: 0,
          format: { sampleRate: 44100, channels: 1, codec: 'mp3' },
        }
      })
    },
    async isAvailable() { return true },
    async dispose() {},
  }
}

describe('generateVoiceover freeze emission (waitForNarration-narrowed windows)', () => {
  beforeAll(() => { fs.mkdirSync(TMP_ROOT, { recursive: true }) })
  afterAll(() => { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) })

  it('audio longer than narrowed window emits a freeze at the window end', async () => {
    // Subtitle 1's window is narrowed to [0, 2000] — the scenario a
    // waitForNarration() marker at 2000ms creates by closing the window
    // before the next narrate (which starts at 5000ms, leaving a gap that
    // holds e.g. clicks). Audio is 4s, so the overflow is ~2s. The freeze
    // must land at the WINDOW END (2000ms = the wait marker), not at the next
    // subtitle's start (5000ms): the renderer has to hold the frame at the
    // wait point until the audio finishes, otherwise the gap content (clicks)
    // plays through before the freeze and appears too early.
    const longAudio = makeSineBuffer(4)
    const shortAudio = makeSineBuffer(1)
    const provider = makeProvider([longAudio, shortAudio])
    const trace: SubtitledTrace = {
      subtitles: [
        { index: 1, startMs: 0, endMs: 2000, text: 'first', ttsText: undefined },
        { index: 2, startMs: 5000, endMs: 7000, text: 'second', ttsText: undefined },
      ],
    } as unknown as SubtitledTrace
    const tmp = path.join(TMP_ROOT, 'overflow')

    const result = await generateVoiceover(trace, provider, tmp)

    expect(result.voiceover.freezes).toHaveLength(1)
    const freeze = result.voiceover.freezes![0]!
    expect(freeze.atVideoMs).toBe(2000)
    // Allow ±200ms for mp3 encoder padding around the 4s sine wave.
    expect(freeze.durationMs).toBeGreaterThan(1800)
    expect(freeze.durationMs).toBeLessThan(2300)
  })

  it('zero/sub-100ms window with overflow still plays audio and freezes (no-autoWait pattern)', async () => {
    // narrate() immediately followed by waitForNarration() on a fast trace:
    // the window is ~0 (here 40ms). The line must NOT be dropped — its audio
    // plays, the subtitle stretches to the audio length, and the video freezes
    // at the boundary. Previously the windowDuration<100 guard dropped it.
    const longAudio = makeSineBuffer(4)
    const shortAudio = makeSineBuffer(1)
    const provider = makeProvider([longAudio, shortAudio])
    const trace: SubtitledTrace = {
      subtitles: [
        { index: 1, startMs: 0, endMs: 40, text: 'first', ttsText: undefined },
        { index: 2, startMs: 100, endMs: 2100, text: 'second', ttsText: undefined },
      ],
    } as unknown as SubtitledTrace
    const tmp = path.join(TMP_ROOT, 'tiny-window-overflow')

    const result = await generateVoiceover(trace, provider, tmp)

    // A freeze is recorded at the boundary (40ms) — previously: none.
    expect(result.voiceover.freezes).toHaveLength(1)
    expect(result.voiceover.freezes![0]!.atVideoMs).toBe(40)
    expect(result.voiceover.freezes![0]!.durationMs).toBeGreaterThan(3500)
    // First subtitle is stretched to ~the audio length, not the 40ms window.
    expect(result.voiceover.entries[0]!.outputEndMs).toBeGreaterThan(3500)
    // Second line is pushed back by the overflow.
    expect(result.voiceover.entries[1]!.outputStartMs).toBeGreaterThan(3500)
  })

  it('exact-zero window (startMs === endMs) still plays audio and freezes', async () => {
    // narrate() with an immediate waitForNarration() and no gap: window is 0.
    const longAudio = makeSineBuffer(3)
    const shortAudio = makeSineBuffer(1)
    const provider = makeProvider([longAudio, shortAudio])
    const trace: SubtitledTrace = {
      subtitles: [
        { index: 1, startMs: 1000, endMs: 1000, text: 'first', ttsText: undefined },
        { index: 2, startMs: 1000, endMs: 3000, text: 'second', ttsText: undefined },
      ],
    } as unknown as SubtitledTrace
    const tmp = path.join(TMP_ROOT, 'zero-window-overflow')

    const result = await generateVoiceover(trace, provider, tmp)

    expect(result.voiceover.freezes).toHaveLength(1)
    expect(result.voiceover.freezes![0]!.atVideoMs).toBe(1000)
    expect(result.voiceover.freezes![0]!.durationMs).toBeGreaterThan(2500)
    expect(result.voiceover.entries[0]!.outputEndMs).toBeGreaterThan(2500)
    expect(result.voiceover.entries[1]!.outputStartMs).toBeGreaterThan(2500)
  })

  it('audio that fits in the narrowed window emits no freeze', async () => {
    const shortAudio = makeSineBuffer(1)
    const provider = makeProvider([shortAudio, shortAudio])
    const trace: SubtitledTrace = {
      subtitles: [
        { index: 1, startMs: 0, endMs: 5000, text: 'first', ttsText: undefined },
        { index: 2, startMs: 6000, endMs: 11_000, text: 'second', ttsText: undefined },
      ],
    } as unknown as SubtitledTrace
    const tmp = path.join(TMP_ROOT, 'no-overflow')

    const result = await generateVoiceover(trace, provider, tmp)

    expect(result.voiceover.freezes).toEqual([])
  })

  it('overflow on the final subtitle emits no freeze (renderer tpad handles it)', async () => {
    // When waitForNarration sits at the end of a trace with no following
    // narrate, the renderer's end-of-video tpad already pads for audio that
    // outlives the visual track — no in-line freeze is needed.
    const longAudio = makeSineBuffer(3)
    const provider = makeProvider([longAudio])
    const trace: SubtitledTrace = {
      subtitles: [
        { index: 1, startMs: 0, endMs: 1000, text: 'only', ttsText: undefined },
      ],
    } as unknown as SubtitledTrace
    const tmp = path.join(TMP_ROOT, 'final-overflow')

    const result = await generateVoiceover(trace, provider, tmp)

    expect(result.voiceover.freezes).toEqual([])
  })

  it('approach hold between subtitles: records a freeze and shifts the later subtitle', async () => {
    const short = makeSineBuffer(1) // 1s fits the 2s windows (no overflow freeze)
    const provider = makeProvider([short, short])
    const trace: SubtitledTrace = {
      subtitles: [
        { index: 1, startMs: 0, endMs: 2000, text: 'a', ttsText: undefined },
        { index: 2, startMs: 5000, endMs: 7000, text: 'b', ttsText: undefined },
      ],
    } as unknown as SubtitledTrace
    const tmp = path.join(TMP_ROOT, 'approach-mid')

    const result = await generateVoiceover(trace, provider, tmp, undefined, [
      { atVideoMs: 3000, durationMs: 500 },
    ])

    expect(result.voiceover.freezes).toContainEqual({ atVideoMs: 3000, durationMs: 500 })
    expect(result.voiceover.entries[1]!.outputStartMs).toBe(5500)
  })

  it('approach hold exactly at a subtitle start still shifts that subtitle', async () => {
    const short = makeSineBuffer(1)
    const provider = makeProvider([short, short])
    const trace: SubtitledTrace = {
      subtitles: [
        { index: 1, startMs: 0, endMs: 2000, text: 'a', ttsText: undefined },
        { index: 2, startMs: 5000, endMs: 7000, text: 'b', ttsText: undefined },
      ],
    } as unknown as SubtitledTrace
    const tmp = path.join(TMP_ROOT, 'approach-at-subtitle-start')

    const result = await generateVoiceover(trace, provider, tmp, undefined, [
      { atVideoMs: 5000, durationMs: 500 },
    ])

    expect(result.voiceover.freezes).toContainEqual({ atVideoMs: 5000, durationMs: 500 })
    expect(result.voiceover.entries[1]!.outputStartMs).toBe(5500)
  })

  it('no approach holds: output is unchanged (regression guard)', async () => {
    const short = makeSineBuffer(1)
    const provider = makeProvider([short, short])
    const trace: SubtitledTrace = {
      subtitles: [
        { index: 1, startMs: 0, endMs: 2000, text: 'a', ttsText: undefined },
        { index: 2, startMs: 5000, endMs: 7000, text: 'b', ttsText: undefined },
      ],
    } as unknown as SubtitledTrace
    const tmp = path.join(TMP_ROOT, 'approach-none')

    const result = await generateVoiceover(trace, provider, tmp, undefined, [])

    expect(result.voiceover.freezes).toEqual([])
    expect(result.voiceover.entries[1]!.outputStartMs).toBe(5000)
  })

  it('trailing approach hold (after the last subtitle): recorded, no shift', async () => {
    const short = makeSineBuffer(1)
    const provider = makeProvider([short, short])
    const trace: SubtitledTrace = {
      subtitles: [
        { index: 1, startMs: 0, endMs: 2000, text: 'a', ttsText: undefined },
        { index: 2, startMs: 5000, endMs: 7000, text: 'b', ttsText: undefined },
      ],
    } as unknown as SubtitledTrace
    const tmp = path.join(TMP_ROOT, 'approach-trailing')

    const result = await generateVoiceover(trace, provider, tmp, undefined, [
      { atVideoMs: 8000, durationMs: 500 },
    ])

    expect(result.voiceover.freezes).toContainEqual({ atVideoMs: 8000, durationMs: 500 })
    expect(result.voiceover.entries[1]!.outputStartMs).toBe(5000)
  })
})
