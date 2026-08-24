import { describe, it, expect } from 'vitest'
import { planVoiceoverFreezes } from '../../../src/render/renderer'

describe('planVoiceoverFreezes in frames', () => {
  it('converts already-aligned freezes without rounding', () => {
    // Task 2 aligns freezes upstream, so these land exactly on frames.
    const { segments } = planVoiceoverFreezes(
      [{ atVideoMs: 2000, durationMs: 1000 }],
      10,
      25,
    )
    expect(segments[0]!.startFrame).toBe(0)
    expect(segments[0]!.endFrame).toBe(50) // 2.000s * 25
    expect(segments[0]!.stopHoldFrames).toBe(25) // 1.000s * 25
  })

  it('gives the boundary frame to the cue that starts on or after it', () => {
    // A cut at 2.000s must not hand frame 50 to the preceding slice.
    const { segments } = planVoiceoverFreezes(
      [{ atVideoMs: 2000, durationMs: 400 }],
      10,
      25,
    )
    expect(segments[0]!.endFrame).toBe(50)
    expect(segments[1]!.startFrame).toBe(50)
  })

  it('emits contiguous slices with no gap or overlap', () => {
    const { segments } = planVoiceoverFreezes(
      [
        { atVideoMs: 1000, durationMs: 200 },
        { atVideoMs: 3000, durationMs: 400 },
        { atVideoMs: 5000, durationMs: 200 },
      ],
      10,
      25,
    )
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.startFrame).toBe(segments[i - 1]!.endFrame)
    }
    expect(segments[segments.length - 1]!.endFrame).toBeNull()
  })

  it('still folds a leading hold into a start-pad (regression)', () => {
    const { segments, totalHoldSec } = planVoiceoverFreezes(
      [{ atVideoMs: 0, durationMs: 2000 }, { atVideoMs: 4000, durationMs: 1000 }],
      10,
      25,
    )
    expect(segments[0]!.startFrame).toBe(0)
    expect(segments[0]!.startHoldFrames).toBe(50)
    expect(totalHoldSec).toBeCloseTo(3.0, 3)
  })

  it('returns no segments when every freeze has zero duration', () => {
    const { segments } = planVoiceoverFreezes([{ atVideoMs: 1000, durationMs: 0 }], 10, 25)
    expect(segments).toEqual([])
  })
})
