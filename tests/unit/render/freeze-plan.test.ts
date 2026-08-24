import { describe, it, expect } from 'vitest'
import { planVoiceoverFreezes } from '../../../src/render/renderer'

const FPS = 25

/** Same ms -> frame conversion the planner uses, applied per freeze. */
const toFrames = (ms: number) => Math.round((ms / 1000) * FPS)

const sumFrames = (fs: Array<{ durationMs: number }>) =>
  fs.reduce((a, f) => a + toFrames(f.durationMs), 0)

const totalApplied = (segs: Array<{ startHoldFrames: number; stopHoldFrames: number }>) =>
  segs.reduce((a, s) => a + s.startHoldFrames + s.stopHoldFrames, 0)

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
    const { segments, totalHoldSec } = planVoiceoverFreezes(freezes, 19.7, FPS)

    // Every freeze duration is realised — nothing dropped.
    expect(totalHoldSec).toBeCloseTo(sumFrames(freezes) / FPS, 6)
    expect(totalApplied(segments)).toBe(sumFrames(freezes))

    // The leading 7.296s hold is a start-pad on the first emitted slice.
    expect(segments[0]!.startFrame).toBe(0)
    expect(segments[0]!.startHoldFrames).toBe(Math.round(7.296 * FPS))
  })

  it('sums coincident freezes onto one cut instead of dropping the duplicate', () => {
    const freezes = [
      { atVideoMs: 5000, durationMs: 500 },
      { atVideoMs: 5000, durationMs: 800 },
    ]
    const { segments, totalHoldSec } = planVoiceoverFreezes(freezes, 19.7, FPS)
    expect(totalHoldSec).toBeCloseTo(sumFrames(freezes) / FPS, 6)
    expect(totalApplied(segments)).toBe(sumFrames(freezes))
  })

  it('holds the last frame of the preceding slice for a mid-video freeze', () => {
    const { segments } = planVoiceoverFreezes([{ atVideoMs: 5000, durationMs: 2000 }], 19.7, FPS)
    expect(segments[0]).toMatchObject({ startFrame: 0, endFrame: 125, startHoldFrames: 0 })
    expect(segments[0]!.stopHoldFrames).toBe(50)
    // Tail runs to end of video.
    expect(segments[segments.length - 1]!.endFrame).toBeNull()
  })

  it('keeps a one-frame freeze so the hold matches the overlay shift', () => {
    // shiftForFreezes() shifts overlays by the full ms freeze list; the planner
    // must not drop small holds or the video would hold less than the overlays
    // shift. (Regression: a <= 0.01s threshold dropped these.) The smallest
    // hold the video can express is one frame, so that is the case to guard.
    const { segments, totalHoldSec } = planVoiceoverFreezes(
      [{ atVideoMs: 5000, durationMs: 40 }],
      19.7,
      FPS,
    )
    expect(totalHoldSec).toBeCloseTo(1 / FPS, 6)
    expect(totalApplied(segments)).toBe(1)
  })

  it('drops a sub-frame freeze that no tpad could express', () => {
    // A 4ms hold at 25fps is a tenth of a frame. The old seconds-based planner
    // emitted stop_duration=0.004, which tpad rounded away to zero frames, so
    // the rendered video never held it either. Dropping it here is explicit
    // rather than silent. Upstream alignment keeps real freezes above this.
    const { segments, totalHoldSec } = planVoiceoverFreezes(
      [{ atVideoMs: 5000, durationMs: 4 }],
      19.7,
      FPS,
    )
    expect(segments).toHaveLength(0)
    expect(totalHoldSec).toBe(0)
  })

  it('ignores freezes at/after the end of the video (handled by end tpad)', () => {
    const { segments, totalHoldSec } = planVoiceoverFreezes(
      [{ atVideoMs: 19700, durationMs: 3000 }],
      19.7,
      FPS,
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
    const { segments, totalHoldSec } = planVoiceoverFreezes(freezes, 19.7, FPS)
    expect(totalApplied(segments)).toBe(sumFrames(freezes))
    expect(totalHoldSec).toBeCloseTo(sumFrames(freezes) / FPS, 6)
    // Both leading holds fold into the first slice's start-pad.
    expect(segments[0]!.startHoldFrames).toBe(Math.round(7.296 * FPS))
  })
})
