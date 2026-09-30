import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildSegments, buildZoomFilter, type ZoomExprConfig } from '../../../src/render/zoom-expression'
import type { ZoomKeyframe } from '../../../src/types/render'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-zoom-nesting-'))
const FPS = 5
const RATE = 1000

// Many zooms, a few seconds apart, as a long screencast with code walkthroughs has.
function keyframes(count: number): ZoomKeyframe[] {
  return Array.from({ length: count }, (_, i) => ({
    atMs: i * 3000,
    transitionMs: 2000,
    x: i % 2 === 0 ? 0.3 : 0.7,
    y: 0.5,
    level: 1.8,
  }))
}

const config = (over: Partial<ZoomExprConfig> = {}): ZoomExprConfig =>
  ({ transitionMs: 400, easing: 'linear', fps: FPS, containInCue: false, ...over })

const filterFor = (kfs: ZoomKeyframe[], over?: Partial<ZoomExprConfig>) => buildZoomFilter(
  kfs, { width: 160, height: 90 }, { width: 160, height: 90 }, config(over),
)

/** z and the center expressions, as functions of aevalsrc's `t`. */
function expressions(filter: string) {
  const arg = (name: string) => filter.match(new RegExp(`${name}='([^']*)'`))![1]!.replaceAll(`in/${FPS}`, 't')
  // x/y wrap the center in the crop clamp; unwrap it.
  const center = (e: string) => e.slice('max(0,min(('.length, e.lastIndexOf(')*i'))
  return { z: arg('z'), cx: center(arg('x')) }
}

/** Evaluate an expression with ffmpeg itself; value[i] is at t = i / RATE. */
function evaluate(expr: string, durationSec: number): number[] {
  const out = path.join(TMP_DIR, `eval-${Math.random().toString(36).slice(2)}.raw`)
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=${RATE}:d=${durationSec}`,
    '-f', 'f64le', '-c:a', 'pcm_f64le', '-y', out,
  ], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
  const buf = fs.readFileSync(out)
  const values: number[] = []
  for (let i = 0; i + 8 <= buf.length; i += 8) values.push(buf.readDoubleLE(i))
  return values
}

/** Deepest parenthesis nesting in a string. */
function maxDepth(expr: string): number {
  let depth = 0, max = 0
  for (const ch of expr) {
    if (ch === '(') max = Math.max(max, ++depth)
    else if (ch === ')') depth--
  }
  return max
}

/**
 * z or cx as the old chain of one if() per segment gave it: the first segment,
 * in buildSegments() order, that covers t. Linear easing.
 */
function chainValue(prop: 'level' | 'cx', kfs: ZoomKeyframe[], T: number, containInCue: boolean, t: number): number {
  const internal = kfs.map(kf => ({ atMs: kf.atMs, holdMs: kf.transitionMs!, x: kf.x!, y: kf.y!, level: kf.level! }))
  const r = (x: number) => Number(x.toFixed(4))
  for (const seg of buildSegments(internal, T, containInCue)) {
    const s = r(seg.startSec), e = r(seg.endSec)
    if (t < s || t > e) continue
    if (seg.type === 'hold') return seg[prop]
    const [from, to] = prop === 'level' ? [seg.fromLevel, seg.toLevel] : [seg.fromCx, seg.toCx]
    if (Math.abs(from - to) < 0.001) return from
    return from + (to - from) * (t - s) / r(e - s)
  }
  return prop === 'level' ? 1.0 : 0.5
}

/** Center of the red pixels in a binary PPM (P6), as fractions of width/height. */
function redCenter(ppm: Buffer): { x: number; y: number } {
  const header = ppm.toString('latin1', 0, 64).split(/\s+/)
  const width = Number(header[1]), height = Number(header[2])
  const dataStart = ppm.length - width * height * 3
  let sx = 0, sy = 0, n = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = dataStart + (y * width + x) * 3
      if (ppm[i]! > 200 && ppm[i + 1]! < 80 && ppm[i + 2]! < 80) { sx += x; sy += y; n++ }
    }
  }
  return { x: sx / n / width, y: sy / n / height }
}

describe('buildZoomFilter with many zooms', () => {
  afterAll(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }))

  // ffmpeg's expression parser caps nesting depth; one nested if() per
  // segment fails with "Missing ')' or too many args" on long videos.
  it('nests logarithmically in the number of segments', () => {
    expect(maxDepth(filterFor(keyframes(400)))).toBeLessThan(30)
  })

  it('nests logarithmically in the samples of a long sampled transition', () => {
    const filter = filterFor(keyframes(400), { transitionMs: 3000, easing: { cubicBezier: [0.4, 0, 0.2, 1] } })
    expect(maxDepth(filter)).toBeLessThan(40)
  })

  // A long hold covers the next, shorter cue: the chain let the earlier
  // segment win everywhere it reaches, and so must the search.
  it('keeps the first segment where keyframes overlap', () => {
    const kfs = [
      { atMs: 0, transitionMs: 3000, level: 1.8, x: 0.3, y: 0.5 },
      { atMs: 1000, transitionMs: 500, level: 1.8, x: 0.7, y: 0.5 },
    ]
    const { z, cx } = expressions(filterFor(kfs))
    const zs = evaluate(z, 4), cxs = evaluate(cx, 4)
    for (const t of [0.8, 1.2, 2.5, 3.0]) {
      expect(zs[t * RATE]).toBeCloseTo(1.8, 4)
      expect(cxs[t * RATE]).toBeCloseTo(0.3, 4)
    }
    expect(zs[3.5 * RATE]).toBeCloseTo(1.0, 4)
  })

  it.each([false, true])('matches the chain on overlapping cues (containInCue %s)', (containInCue) => {
    // Irregular starts and holds, overlapping and touching, at varied levels and targets.
    const kfs: ZoomKeyframe[] = [
      [0, 3000, 1.5, 0.2], [1000, 500, 2.0, 0.8], [2600, 900, 1.8, 0.4], [3500, 300, 1.3, 0.6],
      [4200, 1200, 2.2, 0.3], [4800, 1500, 1.6, 0.7], [7000, 200, 1.9, 0.1], [7300, 800, 1.4, 0.9],
    ].map(([atMs, transitionMs, level, x]) => ({ atMs, transitionMs, level, x, y: 0.5 }))
    const duration = 9
    const { z, cx } = expressions(filterFor(kfs, { containInCue }))
    const zs = evaluate(z, duration), cxs = evaluate(cx, duration)
    for (let i = 0; i < duration * RATE; i++) {
      const t = i / RATE
      expect(zs[i], `z at t=${t}`).toBeCloseTo(chainValue('level', kfs, 0.4, containInCue, t), 3)
      expect(cxs[i], `cx at t=${t}`).toBeCloseTo(chainValue('cx', kfs, 0.4, containInCue, t), 3)
    }
  })

  it('renders, and zooms onto the right target late in the video', () => {
    const kfs = keyframes(400)
    const last = kfs.length - 1
    // Mid-hold of the last keyframe (it holds for its transitionMs).
    const atSec = (kfs[last]!.atMs + 1000) / 1000
    const target = kfs[last]!
    const out = path.join(TMP_DIR, 'frame.ppm')
    // Too long for argv. A script in our own directory, not the renderer's
    // shared spill directory, which another test watches.
    const script = path.join(TMP_DIR, 'filter.txt')
    fs.writeFileSync(script, filterFor(kfs))
    // zoompan counts input frames, so seek on the output; a low rate and a
    // small frame keep that cheap.
    execFileSync('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi',
      '-i', `color=white:s=160x90:d=${atSec + 1}:r=${FPS},drawbox=x=${160 * target.x! - 4}:y=${90 * target.y! - 4}:w=8:h=8:color=red:t=fill`,
      '-filter_script:v', script, '-ss', String(atSec), '-frames:v', '1', out,
    ], { stdio: 'pipe' })

    const center = redCenter(fs.readFileSync(out))
    expect(center.x).toBeCloseTo(0.5, 1)
    expect(center.y).toBeCloseTo(0.5, 1)
  }, 60_000)
})
