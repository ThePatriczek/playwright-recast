import { describe, it, expect } from 'vitest'
import { buildSegments } from '../../../src/render/zoom-expression'

const kf = (atMs: number, holdMs: number) => ({
  atMs, holdMs, level: 2.0, x: 0.5, y: 0.5,
})

describe('buildSegments with containInCue', () => {
  it('keeps every segment inside its cue', () => {
    const segs = buildSegments([kf(1000, 2000)], 0.4, true)
    for (const s of segs) {
      expect(s.startSec).toBeGreaterThanOrEqual(1.0)
      expect(s.endSec).toBeLessThanOrEqual(3.0)
    }
  })

  it('zooms in at the cue start and out at the cue end', () => {
    const segs = buildSegments([kf(1000, 2000)], 0.4, true)
    expect(segs[0]!.startSec).toBeCloseTo(1.0, 3)
    expect(segs[segs.length - 1]!.endSec).toBeCloseTo(3.0, 3)
  })

  it('splits a cue shorter than 2T evenly with no hold', () => {
    // 0.6s cue, T=0.4 → transition clamps to 0.3, in and out meet at the middle.
    const segs = buildSegments([kf(1000, 600)], 0.4, true)
    expect(segs.filter((s) => s.type === 'hold')).toHaveLength(0)
    expect(segs[0]!.endSec).toBeCloseTo(1.3, 3)
    expect(segs[segs.length - 1]!.startSec).toBeCloseTo(1.3, 3)
  })

  it('never leaks into an adjacent cue', () => {
    const segs = buildSegments([kf(1000, 1000), kf(2000, 1000)], 0.4, true)
    const first = segs.filter((s) => s.endSec <= 2.0)
    const second = segs.filter((s) => s.startSec >= 2.0)
    expect(first.length + second.length).toBe(segs.length)
  })

  it('with the flag off, still overruns the cue exactly as before', () => {
    // Regression guard: today's behaviour is the default and must not move.
    const segs = buildSegments([kf(1000, 2000)], 0.4, false)
    expect(segs[0]!.startSec).toBeCloseTo(0.6, 3) // startSec - T
    expect(segs[segs.length - 1]!.endSec).toBeCloseTo(3.4, 3) // endSec + T
  })
})
