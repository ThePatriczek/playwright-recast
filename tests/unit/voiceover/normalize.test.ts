import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { normalizeLoudness } from '../../../src/voiceover/normalize'

const TMP_ROOT = path.join(os.tmpdir(), `recast-normalize-test-${process.pid}`)

/** Generate a 4-second 440Hz sine mp3 at a given gain (dB). ebur128 needs ≥3s
 *  of signal to compute integrated loudness reliably. */
function makeSineMp3(outPath: string, gainDb: number): void {
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=44100:duration=4',
    '-af', `volume=${gainDb}dB`,
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k',
    outPath,
  ])
}

/** Parse ebur128 integrated loudness (LUFS) from ffmpeg stderr. */
function measureLufs(file: string): number {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file,
    '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  const m = (r.stderr ?? '').match(/Integrated loudness:[\s\S]*?I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/)
  if (!m) throw new Error(`Could not parse LUFS from ffmpeg output:\n${r.stderr}`)
  return Number(m[1])
}

describe('normalizeLoudness', () => {
  beforeAll(() => { fs.mkdirSync(TMP_ROOT, { recursive: true }) })
  afterAll(() => { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) })

  it('raises a quiet input to the target LUFS (within 1.5 LU tolerance)', async () => {
    const quiet = path.join(TMP_ROOT, 'quiet.mp3')
    const out = path.join(TMP_ROOT, 'quiet-norm.mp3')
    makeSineMp3(quiet, -30)
    await normalizeLoudness(quiet, out, { targetLufs: -16 })
    const i = measureLufs(out)
    expect(i).toBeGreaterThan(-17.5)
    expect(i).toBeLessThan(-14.5)
  })

  it('lowers a loud input to the target LUFS (within 1.5 LU tolerance)', async () => {
    const loud = path.join(TMP_ROOT, 'loud.mp3')
    const out = path.join(TMP_ROOT, 'loud-norm.mp3')
    makeSineMp3(loud, -6)
    await normalizeLoudness(loud, out, { targetLufs: -16 })
    const i = measureLufs(out)
    expect(i).toBeGreaterThan(-17.5)
    expect(i).toBeLessThan(-14.5)
  })

  it('writes a valid mp3 file', async () => {
    const src = path.join(TMP_ROOT, 'src.mp3')
    const out = path.join(TMP_ROOT, 'out.mp3')
    makeSineMp3(src, -20)
    await normalizeLoudness(src, out)
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(1000)
  })
})
