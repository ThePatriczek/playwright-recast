import { describe, it, expect } from 'vitest'
import { shiftOverlaysForHolds } from '../../../src/render/renderer'
import { approachHold } from '../../../src/voiceover/frame-align'

describe('approachHold()', () => {
  it('sits 2ms before its click, clamped to 0 with the source kept', () => {
    expect(approachHold(1000, 500)).toEqual({ atVideoMs: 998, durationMs: 500, sourceMs: 998 })
    expect(approachHold(0, 500)).toEqual({ atVideoMs: 0, durationMs: 500, sourceMs: -2 })
  })
})

describe('shiftOverlaysForHolds()', () => {
  it('moves a click and its cursor keyframe behind a hold by their trace times', () => {
    // waitForNarration() at 999.6 (rounded source 1000), click 0.3ms later:
    // the click rounds to 1000, its keyframe stays at 999.9.
    const trace = {
      clickEvents: [{ x: 0, y: 0, videoTimeMs: 1000, traceMs: 999.9 }],
      cursorKeyframes: [{ x: 0, y: 0, videoTimeSec: 0.9999, traceMs: 999.9 }],
    }
    shiftOverlaysForHolds(trace, [{ atVideoMs: 1040, durationMs: 2000, sourceMs: 1000, sourceTraceMs: 999.6 }])
    expect(trace.clickEvents[0]!.videoTimeMs).toBe(3000)
    expect(trace.cursorKeyframes[0]!.videoTimeSec).toBeCloseTo(2.9999, 6)
  })

  it('moves a click at 0 behind its approach hold', () => {
    const trace = {
      clickEvents: [{ x: 0, y: 0, videoTimeMs: 0 }],
      cursorKeyframes: [{ x: 0, y: 0, videoTimeSec: 0, approach: true }],
    }
    shiftOverlaysForHolds(trace, [approachHold(0, 500)])
    expect(trace.clickEvents[0]!.videoTimeMs).toBe(500)
    expect(trace.cursorKeyframes[0]!.videoTimeSec).toBe(0.5)
  })
})
