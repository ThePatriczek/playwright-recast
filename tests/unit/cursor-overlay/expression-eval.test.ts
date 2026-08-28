import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildOverlayExpressions } from '../../../src/cursor-overlay/expression-builder'
import { resolveCursorOverlayConfig } from '../../../src/cursor-overlay/defaults'
import type { CursorKeyframe } from '../../../src/types/cursor-overlay'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-expr-eval-'))
const RATE = 1000

/**
 * Evaluate an overlay expression with ffmpeg itself: `aevalsrc` runs the same
 * evaluator, one sample per millisecond, so value[i] is the expression at
 * t = i / RATE.
 */
function evaluate(expr: string, durationSec: number): number[] {
  const out = path.join(TMP_DIR, `eval-${Math.random().toString(36).slice(2)}.raw`)
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=${RATE}:d=${durationSec}`,
    '-f', 'f64le', '-c:a', 'pcm_f64le', '-y', out,
  ], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })

  const buf = fs.readFileSync(out)
  fs.unlinkSync(out)
  const values: number[] = []
  for (let i = 0; i + 8 <= buf.length; i += 8) values.push(buf.readDoubleLE(i))
  return values
}

const at = (values: number[], t: number) => values[Math.round(t * RATE)]!

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

const viewport = { width: 1280, height: 720 }
const srcRes = { width: 1280, height: 720 }

describe('overlay expressions evaluated by ffmpeg', () => {
  it('places the cursor at every phase of a two-keyframe trajectory', () => {
    const keyframes: CursorKeyframe[] = [
      { x: 100, y: 100, videoTimeSec: 2 },
      { x: 500, y: 400, videoTimeSec: 5 },
    ]
    const { x } = buildOverlayExpressions(keyframes, resolveCursorOverlayConfig({}), viewport, srcRes)
    const v = evaluate(x, 6)

    expect(at(v, 1.5)).toBe(0)          // before the approach starts
    expect(at(v, 1.75)).toBeCloseTo(60, 3)  // approach starts 40px short
    expect(at(v, 1.875)).toBeCloseTo(80, 3) // eased halfway
    expect(at(v, 2.0)).toBeCloseTo(100, 3)  // arrival
    expect(at(v, 2.4)).toBeCloseTo(100, 3)  // held while visible
    expect(at(v, 2.6)).toBe(0)          // past hideAfterMs
    expect(at(v, 4.75)).toBeCloseTo(100, 3) // second approach starts at the old spot
    expect(at(v, 5.0)).toBeCloseTo(500, 3)
    expect(at(v, 5.4)).toBeCloseTo(500, 3)
    expect(at(v, 5.6)).toBe(0)
  })

  it('lets a later movement win while visibility windows overlap', () => {
    const config = resolveCursorOverlayConfig({ moveDurationMs: 500, hideAfterMs: 500 })
    const keyframes: CursorKeyframe[] = [
      { x: 100, y: 100, videoTimeSec: 2 },
      { x: 200, y: 200, videoTimeSec: 2.2 },
    ]
    const { x } = buildOverlayExpressions(keyframes, config, viewport, srcRes)
    const v = evaluate(x, 3.5)

    expect(at(v, 1.5)).toBeCloseTo(60, 3)   // first approach
    expect(at(v, 2.0)).toBeCloseTo(100, 3)  // first arrival, second approach starts
    expect(at(v, 2.1)).toBeCloseTo(150, 3)  // eased halfway to the second target
    expect(at(v, 2.2)).toBeCloseTo(200, 3)
    expect(at(v, 2.4)).toBeCloseTo(200, 3)  // later keyframe wins over the first hold
    expect(at(v, 2.71)).toBe(0)
  })

  it('scales viewport coordinates to the source resolution', () => {
    const { x, y } = buildOverlayExpressions(
      [{ x: 100, y: 200, videoTimeSec: 2 }],
      resolveCursorOverlayConfig({}),
      viewport,
      { width: 1920, height: 1080 },
    )
    expect(at(evaluate(x, 3), 2.0)).toBeCloseTo(150, 3)
    expect(at(evaluate(y, 3), 2.0)).toBeCloseTo(300, 3)
  })

  it('stays parseable for long screencasts with hundreds of keyframes', () => {
    const keyframes: CursorKeyframe[] = Array.from({ length: 200 }, (_, i) => ({
      x: 100 + i, y: 200 + i, videoTimeSec: 2 + i * 3,
    }))
    const { x, y } = buildOverlayExpressions(keyframes, resolveCursorOverlayConfig({}), viewport, srcRes)

    // Sample around the 150th keyframe — beyond ffmpeg's expression nesting budget.
    const vx = evaluate(x, 452)
    expect(at(vx, 449)).toBeCloseTo(249, 3)
    expect(at(vx, 451)).toBe(0)
    const vy = evaluate(y, 452)
    expect(at(vy, 449)).toBeCloseTo(349, 3)
  })
})
