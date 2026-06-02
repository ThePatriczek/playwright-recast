import { describe, it, expect } from 'vitest'
import { planVoiceoverFreezes } from '../../../src/render/renderer'

const sum = (fs: Array<{ durationMs: number }>) =>
  fs.reduce((a, f) => a + f.durationMs, 0) / 1000

const totalApplied = (segs: Array<{ startHoldSec: number; stopHoldSec: number }>) =>
  segs.reduce((a, s) => a + s.startHoldSec + s.stopHoldSec, 0)

describe('planVoiceoverFreezes', () => {
  it('applies a leading freeze at position 0 as a start-pad (regression: was dropped)', () => {
    // The intro narration's window collapses to ~0, so its overflow freeze
    // lands at videoMs 0. Previously this was skipped (empty leading slice),
    // but shiftForFreezes() still shifted every click by it — desyncing the
    // overlays from the video by the full hold. The hold MUST be applied.
    const freezes = [
      { atVideoMs: 0, durationMs: 7296 },
      { atVideoMs: 760, durationMs: 3936 },
      { atVideoMs: 947, durationMs: 500 },
    ]
    const { segments, totalHoldSec } = planVoiceoverFreezes(freezes, 19.7)

    // Every freeze duration is realised — nothing dropped.
    expect(totalHoldSec).toBeCloseTo(sum(freezes), 3)
    expect(totalApplied(segments)).toBeCloseTo(sum(freezes), 3)

    // The leading 7.296s hold is a start-pad on the first emitted slice.
    expect(segments[0]!.startSec).toBe(0)
    expect(segments[0]!.startHoldSec).toBeCloseTo(7.296, 3)
  })

  it('sums coincident freezes onto one cut instead of dropping the duplicate', () => {
    const freezes = [
      { atVideoMs: 5000, durationMs: 500 },
      { atVideoMs: 5000, durationMs: 800 },
    ]
    const { segments, totalHoldSec } = planVoiceoverFreezes(freezes, 19.7)
    expect(totalHoldSec).toBeCloseTo(1.3, 3)
    expect(totalApplied(segments)).toBeCloseTo(1.3, 3)
  })

  it('holds the last frame of the preceding slice for a mid-video freeze', () => {
    const { segments } = planVoiceoverFreezes([{ atVideoMs: 5000, durationMs: 2000 }], 19.7)
    expect(segments[0]).toMatchObject({ startSec: 0, endSec: 5, startHoldSec: 0 })
    expect(segments[0]!.stopHoldSec).toBeCloseTo(2, 3)
    // Tail runs to end of video.
    expect(segments[segments.length - 1]!.endSec).toBeNull()
  })

  it('keeps small (sub-10ms) freezes so the hold matches the overlay shift', () => {
    // shiftForFreezes() shifts overlays by the full ms freeze list; the planner
    // must not drop small holds or the video would hold less than the overlays
    // shift. (Regression: a <= 0.01s threshold dropped these.)
    const { segments, totalHoldSec } = planVoiceoverFreezes(
      [{ atVideoMs: 5000, durationMs: 4 }],
      19.7,
    )
    expect(totalHoldSec).toBeCloseTo(0.004, 4)
    expect(segments.reduce((a, s) => a + s.startHoldSec + s.stopHoldSec, 0)).toBeCloseTo(0.004, 4)
  })

  it('ignores freezes at/after the end of the video (handled by end tpad)', () => {
    const { segments, totalHoldSec } = planVoiceoverFreezes(
      [{ atVideoMs: 19700, durationMs: 3000 }],
      19.7,
    )
    expect(segments).toHaveLength(0)
    expect(totalHoldSec).toBe(0)
  })

  it('keeps the overlay-shift invariant: total held == sum of in-range freezes', () => {
    const freezes = [
      { atVideoMs: 0, durationMs: 6000 },
      { atVideoMs: 0, durationMs: 1296 }, // two leading holds
      { atVideoMs: 760, durationMs: 3936 },
      { atVideoMs: 5641, durationMs: 4032 },
      { atVideoMs: 10580, durationMs: 500 },
    ]
    const { segments, totalHoldSec } = planVoiceoverFreezes(freezes, 19.7)
    expect(totalApplied(segments)).toBeCloseTo(sum(freezes), 3)
    expect(totalHoldSec).toBeCloseTo(sum(freezes), 3)
    // Both leading holds fold into the first slice's start-pad.
    expect(segments[0]!.startHoldSec).toBeCloseTo(7.296, 3)
  })
})
