import { describe, it, expect } from 'vitest'
import { shiftOverlaysForHolds, mouseIndicatorSpans, keyOverlayPosition } from '../../../src/render/renderer'
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

describe('shiftOverlaysForHolds() on a cursor travel', () => {
  it('lengthens a travel a hold lands inside, and moves one after it', () => {
    const trace = {
      cursorKeyframes: [
        { x: 0, y: 0, videoTimeSec: 3, traceMs: 3000, travelSec: 2, travelTraceMs: 1000 },
        { x: 0, y: 0, videoTimeSec: 8, traceMs: 8000, travelSec: 1, travelTraceMs: 7000 },
      ],
    }
    shiftOverlaysForHolds(trace, [{ atVideoMs: 2000, durationMs: 500, sourceMs: 2000, sourceTraceMs: 2000 }])
    expect(trace.cursorKeyframes[0]).toMatchObject({ videoTimeSec: 3.5, travelSec: 2.5 })
    expect(trace.cursorKeyframes[1]).toMatchObject({ videoTimeSec: 8.5, travelSec: 1 })
  })
})

describe('shiftOverlaysForHolds() on input events', () => {
  it('moves mouse and key inputs by their trace times', () => {
    const trace = {
      mouseInputEvents: [{ input: 'right' as const, videoTimeMs: 1000, endTimeMs: 3000, traceMs: 1000, endTraceMs: 3000 }],
      keyOverlayEvents: [{ text: 'Esc', input: 'special' as const, videoTimeMs: 4000, endTimeMs: 4000, traceMs: 4000, endTraceMs: 4000 }],
    }
    shiftOverlaysForHolds(trace, [{ atVideoMs: 2000, durationMs: 500, sourceMs: 2000, sourceTraceMs: 2000 }])
    expect(trace.mouseInputEvents[0]).toMatchObject({ videoTimeMs: 1000, endTimeMs: 3500 })
    expect(trace.keyOverlayEvents[0]).toMatchObject({ videoTimeMs: 4500, endTimeMs: 4500 })
  })
})

describe('mouseIndicatorSpans()', () => {
  it('shows each input for at least minShowMs, only while the cursor is visible, by icon', () => {
    const spans = mouseIndicatorSpans([
      { input: 'wheel', direction: 'up', videoTimeMs: 1000, endTimeMs: 1000 },
      { input: 'wheel', direction: 'up', videoTimeMs: 1200, endTimeMs: 1200 },
      { input: 'right', videoTimeMs: 2000, endTimeMs: 5000 },
      { input: 'middle', videoTimeMs: 9000, endTimeMs: 9000 },
    ], [[0.5, 4]], 400)
    expect([...spans.keys()]).toEqual(['wheel-up', 'right'])
    expect(spans.get('wheel-up')).toEqual([[1, 1.4], [1.2, 1.6]])
    expect(spans.get('right')).toEqual([[2, 4]])
  })
})

describe('keyOverlayPosition()', () => {
  it('moves the keycap to the top when subtitles are burned in at the bottom, unless set', () => {
    expect(keyOverlayPosition({}, false)).toBe('bottom')
    expect(keyOverlayPosition({}, true)).toBe('top')
    expect(keyOverlayPosition({ position: 'bottom' }, true)).toBe('bottom')
  })
})
