import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { generateVoiceover } from '../../../src/voiceover/voiceover-processor'
import type { TtsProvider } from '../../../src/types/voiceover'
import type { SubtitledTrace } from '../../../src/types/subtitle'

const TMP_ROOT = path.join(os.tmpdir(), `recast-vo-processor-test-${process.pid}`)

function makeSineBuffer(gainDb: number, durationSec = 4): Buffer {
  const out = path.join(TMP_ROOT, `sine-${gainDb}-${Math.random().toString(36).slice(2)}.mp3`)
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `sine=frequency=440:sample_rate=44100:duration=${durationSec}`,
    '-af', `volume=${gainDb}dB`,
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k',
    out,
  ])
  const buf = fs.readFileSync(out)
  fs.rmSync(out)
  return buf
}

function measureLufs(file: string): number {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file,
    '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  const m = (r.stderr ?? '').match(/Integrated loudness:[\s\S]*?I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/)
  if (!m) throw new Error(`Could not parse LUFS:\n${r.stderr}`)
  return Number(m[1])
}

function levelAlternatingProvider(buffers: Buffer[]): TtsProvider {
  let i = 0
  return {
    name: 'fake-alt',
    async synthesize() {
      const data = buffers[i++ % buffers.length]!
      return { data, durationMs: 0, format: { sampleRate: 44100, channels: 1, codec: 'mp3' } }
    },
    estimateDurationMs() { return 0 },
    async isAvailable() { return true },
    async dispose() {},
  }
}

function makeTrace(subtitleCount: number): SubtitledTrace {
  const subs = Array.from({ length: subtitleCount }, (_, k) => ({
    index: k + 1,
    startMs: k * 6000,
    endMs: k * 6000 + 5000, // 5s windows — 4s sine fits without overflow
    text: `line ${k + 1}`,
    ttsText: undefined as string | undefined,
  }))
  return { subtitles: subs } as unknown as SubtitledTrace
}

describe('generateVoiceover with VoiceoverOptions.normalize', () => {
  beforeAll(() => { fs.mkdirSync(TMP_ROOT, { recursive: true }) })
  afterAll(() => { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) })

  it('without normalize, per-segment levels differ widely', async () => {
    const quiet = makeSineBuffer(-30)
    const loud = makeSineBuffer(-6)
    const provider = levelAlternatingProvider([quiet, loud])
    const tmp = path.join(TMP_ROOT, 'no-norm')
    const trace = makeTrace(2)

    const result = await generateVoiceover(trace, provider, tmp)
    const l1 = measureLufs(path.join(tmp, 'seg-1.mp3'))
    const l2 = measureLufs(path.join(tmp, 'seg-2.mp3'))
    expect(Math.abs(l1 - l2)).toBeGreaterThan(10)
    expect(result.voiceover.entries).toHaveLength(2)
  })

  it('with normalize: true, per-segment levels converge to target (within 2 LU)', async () => {
    const quiet = makeSineBuffer(-30)
    const loud = makeSineBuffer(-6)
    const provider = levelAlternatingProvider([quiet, loud])
    const tmp = path.join(TMP_ROOT, 'norm-on')
    const trace = makeTrace(2)

    await generateVoiceover(trace, provider, tmp, { normalize: true })
    const l1 = measureLufs(path.join(tmp, 'seg-1.mp3'))
    const l2 = measureLufs(path.join(tmp, 'seg-2.mp3'))
    expect(Math.abs(l1 - l2)).toBeLessThan(2)
    expect(l1).toBeGreaterThan(-18)
    expect(l1).toBeLessThan(-14)
  })

  it('respects custom targetLufs', async () => {
    const quiet = makeSineBuffer(-30)
    const provider = levelAlternatingProvider([quiet])
    const tmp = path.join(TMP_ROOT, 'norm-custom')
    const trace = makeTrace(1)

    await generateVoiceover(trace, provider, tmp, { normalize: { targetLufs: -22 } })
    const l = measureLufs(path.join(tmp, 'seg-1.mp3'))
    expect(l).toBeGreaterThan(-24)
    expect(l).toBeLessThan(-20)
  })
})
