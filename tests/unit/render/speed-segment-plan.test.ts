import { describe, it, expect } from 'vitest'
import { planSpeedSegments } from '../../../src/render/renderer'

const totalFrames = (plan: Array<{ frames: number }>) =>
  plan.reduce((a, s) => a + s.frames, 0)

describe('planSpeedSegments', () => {
  it('plans the issue #20 reproduction exactly: 4x 2s @ 2x on 25fps = 25 frames each', () => {
    // Regression: each segment was encoded independently and came out 27
    // frames (1.08s) instead of 25 (1.00s), so four segments drifted +0.32s
    // against the ideal durations subtitle remapping assumes.
    const segments = [0, 2, 4, 6].map((s) => ({ startSec: s, endSec: s + 2, speed: 2 }))
    const plan = planSpeedSegments(segments, 25)

    expect(plan.map((s) => s.frames)).toEqual([25, 25, 25, 25])
  })

  it('never drifts: cumulative frames always equal round(totalOutputSec * fps)', () => {
    const speeds = [1, 4, 2, 1, 8, 2, 1, 4, 1, 2, 16, 1, 2, 4, 1, 2, 1, 8, 2, 1]
    let t = 0
    const segments = speeds.map((speed, i) => {
      const startSec = t
      const endSec = t + 0.7 + (i % 5) * 0.3 // irregular, non-frame-aligned
      t = endSec
      return { startSec, endSec, speed }
    })

    const plan = planSpeedSegments(segments, 25)
    const idealTotalSec = segments.reduce(
      (a, s) => a + (s.endSec - s.startSec) / s.speed, 0,
    )

    expect(totalFrames(plan)).toBe(Math.round(idealTotalSec * 25))
  })

  it('corrects each rounding error on the next segment rather than accumulating it', () => {
    // 1.5s at 25fps = 37.5 frames. Independent rounding would give 38/38/38
    // (+1.5 frames after three); cumulative gives 38/37/38 = 113 = round(112.5).
    const segments = [0, 1.5, 3].map((s) => ({ startSec: s, endSec: s + 1.5, speed: 1 }))
    const plan = planSpeedSegments(segments, 25)

    expect(totalFrames(plan)).toBe(113)
    expect(plan.map((s) => s.frames)).toEqual([38, 37, 38])
  })

  it('drops sub-frame segments instead of planning zero frames', () => {
    // -frames:v 0 produces an empty file that breaks the concat demuxer.
    const segments = [
      { startSec: 0, endSec: 2, speed: 1 },
      { startSec: 2, endSec: 2.06, speed: 100 }, // 0.0006s ≈ 0.015 frames
      { startSec: 2.06, endSec: 4.06, speed: 1 },
    ]
    const plan = planSpeedSegments(segments, 25)

    expect(plan).toHaveLength(2)
    expect(plan.every((s) => s.frames > 0)).toBe(true)
  })

  it('does not let a dropped segment steal frames from later segments', () => {
    const segments = [
      { startSec: 0, endSec: 2, speed: 1 },
      { startSec: 2, endSec: 2.06, speed: 100 },
      { startSec: 2.06, endSec: 4.06, speed: 1 },
    ]
    const plan = planSpeedSegments(segments, 25)

    expect(plan.map((s) => s.frames)).toEqual([50, 50])
  })

  it('preserves the source seek window and speed of each retained segment', () => {
    const plan = planSpeedSegments([{ startSec: 3, endSec: 7, speed: 4 }], 25)

    expect(plan[0]!.startSec).toBe(3)
    expect(plan[0]!.endSec).toBe(7)
    expect(plan[0]!.speed).toBe(4)
    expect(plan[0]!.frames).toBe(25) // 4s / 4x = 1s
  })

  it('returns an empty plan for an empty input', () => {
    expect(planSpeedSegments([], 25)).toEqual([])
  })
})
