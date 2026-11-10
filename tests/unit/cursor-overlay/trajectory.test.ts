import { describe, it, expect } from 'vitest'
import { linear, easeInOut, easeOut, getEasingFn, buildTrajectory } from '../../../src/cursor-overlay/trajectory'

describe('easing functions', () => {
  describe('linear', () => {
    it('returns 0 at start', () => expect(linear(0)).toBe(0))
    it('returns 0.5 at midpoint', () => expect(linear(0.5)).toBe(0.5))
    it('returns 1 at end', () => expect(linear(1)).toBe(1))
  })

  describe('easeInOut (smoothstep)', () => {
    it('returns 0 at start', () => expect(easeInOut(0)).toBe(0))
    it('returns 0.5 at midpoint', () => expect(easeInOut(0.5)).toBe(0.5))
    it('returns 1 at end', () => expect(easeInOut(1)).toBe(1))
    it('is slower at start (value < input)', () => expect(easeInOut(0.25)).toBeLessThan(0.25))
    it('is slower at end (value > input)', () => expect(easeInOut(0.75)).toBeGreaterThan(0.75))
  })

  describe('easeOut', () => {
    it('returns 0 at start', () => expect(easeOut(0)).toBe(0))
    it('returns 1 at end', () => expect(easeOut(1)).toBe(1))
    it('is faster at start (value > input)', () => expect(easeOut(0.5)).toBeGreaterThan(0.5))
  })

  describe('getEasingFn', () => {
    it('returns linear fn', () => expect(getEasingFn('linear')).toBe(linear))
    it('returns easeInOut fn', () => expect(getEasingFn('ease-in-out')).toBe(easeInOut))
    it('returns easeOut fn', () => expect(getEasingFn('ease-out')).toBe(easeOut))
  })
})

describe('buildTrajectory', () => {
  it('returns empty array for no actions', () => {
    const result = buildTrajectory({
      actions: [],
      videoStartOffsetMs: 0,
    })
    expect(result).toEqual([])
  })

  it('returns empty array when no actions have point data', () => {
    const result = buildTrajectory({
      actions: [{ startTime: 1000 }, { startTime: 2000 }],
      videoStartOffsetMs: 0,
    })
    expect(result).toEqual([])
  })

  it('builds keyframes from actions with points', () => {
    const result = buildTrajectory({
      actions: [
        { point: { x: 100, y: 200 }, startTime: 1000 },
        { point: { x: 300, y: 400 }, startTime: 3000 },
      ],
      videoStartOffsetMs: 0,
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ x: 100, y: 200, videoTimeSec: 1, autoWaitSec: 0, traceMs: 1000 })
    expect(result[1]).toEqual({ x: 300, y: 400, videoTimeSec: 3, autoWaitSec: 0, traceMs: 3000 })
  })

  it('uses endTime when present (cursor lands when the action completes, not when it starts)', () => {
    const result = buildTrajectory({
      actions: [
        // A click on a still-loading element: startTime 1000, but it only
        // lands at endTime 4000 after auto-wait. The keyframe must use 4000.
        { point: { x: 100, y: 200 }, startTime: 1000, endTime: 4000 },
      ],
      videoStartOffsetMs: 0,
    })
    // 3s of auto-wait (4000 - 1000) is recorded so the cursor's pre-click
    // approach can be trimmed to avoid gliding over the loading screen.
    expect(result[0]).toEqual({ x: 100, y: 200, videoTimeSec: 4, autoWaitSec: 3, traceMs: 4000 })
  })

  it('falls back to startTime when endTime is absent', () => {
    const result = buildTrajectory({
      actions: [{ point: { x: 10, y: 20 }, startTime: 2000 }],
      videoStartOffsetMs: 0,
    })
    expect(result[0]!.videoTimeSec).toBe(2)
  })

  it('applies video start offset', () => {
    const result = buildTrajectory({
      actions: [{ point: { x: 50, y: 50 }, startTime: 5000 }],
      videoStartOffsetMs: 2000,
    })
    expect(result[0]!.videoTimeSec).toBe(3) // (5000 - 2000) / 1000
  })

  it('clamps negative times to 0', () => {
    const result = buildTrajectory({
      actions: [{ point: { x: 50, y: 50 }, startTime: 500 }],
      videoStartOffsetMs: 1000,
    })
    expect(result[0]!.videoTimeSec).toBe(0)
  })

  it('applies filter function', () => {
    const result = buildTrajectory({
      actions: [
        { point: { x: 100, y: 100 }, startTime: 1000 },
        { point: { x: 200, y: 200 }, startTime: 2000 },
        { point: { x: 300, y: 300 }, startTime: 3000 },
      ],
      filter: (a) => a.startTime !== 2000,
      videoStartOffsetMs: 0,
    })
    expect(result).toHaveLength(2)
    expect(result[0]!.x).toBe(100)
    expect(result[1]!.x).toBe(300)
  })

  it('applies time remap function', () => {
    const result = buildTrajectory({
      actions: [{ point: { x: 100, y: 100 }, startTime: 2000 }],
      timeRemap: (t) => t * 2, // double the time
      videoStartOffsetMs: 1000,
    })
    // timeRemap(2000) = 4000, minus offset 1000 = 3000ms = 3s
    expect(result[0]!.videoTimeSec).toBe(3)
  })

  it('sorts keyframes by time', () => {
    const result = buildTrajectory({
      actions: [
        { point: { x: 300, y: 300 }, startTime: 3000 },
        { point: { x: 100, y: 100 }, startTime: 1000 },
        { point: { x: 200, y: 200 }, startTime: 2000 },
      ],
      videoStartOffsetMs: 0,
    })
    expect(result[0]!.videoTimeSec).toBeLessThan(result[1]!.videoTimeSec)
    expect(result[1]!.videoTimeSec).toBeLessThan(result[2]!.videoTimeSec)
  })
})

describe('buildTrajectory from mouse.down/move/up', () => {
  // The shape of a box-select drag in a real trace: a 30-step move took 2s.
  const drag = [
    { point: { x: 100, y: 100 }, startTime: 900, endTime: 1000, method: 'mouseMove', params: { x: 100, y: 100, steps: 8 } },
    { point: { x: 100, y: 100 }, startTime: 1000, endTime: 1005, method: 'mouseDown', params: { button: 'left' } },
    { point: { x: 400, y: 100 }, startTime: 1010, endTime: 3010, method: 'mouseMove', params: { x: 400, y: 100, steps: 30 } },
    { point: { x: 400, y: 100 }, startTime: 4000, endTime: 4005, method: 'mouseUp', params: { button: 'left' } },
  ]

  it('travels a stepped move over its own duration instead of reading it as an auto-wait', () => {
    const kf = buildTrajectory({ actions: drag, videoStartOffsetMs: 0 })
    expect(kf[2]).toMatchObject({ x: 400, videoTimeSec: 3.01, autoWaitSec: 0, travelSec: 2, travelTraceMs: 1010 })
    expect(kf[0]).toMatchObject({ travelSec: 0.1 })
  })

  it('remaps the travel span through the time remap', () => {
    const kf = buildTrajectory({ actions: drag, videoStartOffsetMs: 0, timeRemap: (t) => t * 2 })
    expect(kf[2]!.travelSec).toBe(4)
  })

  it('marks the keyframes a button is held after, through the release', () => {
    const kf = buildTrajectory({ actions: drag, videoStartOffsetMs: 0 })
    expect(kf.map((k) => k.held ?? false)).toEqual([false, true, true, false])
  })

  it('travels a move without steps too: its trace span is never an auto-wait', () => {
    const kf = buildTrajectory({
      actions: [{ point: { x: 5, y: 5 }, startTime: 1000, endTime: 1004, method: 'mouseMove', params: { x: '5', y: '5' } }],
      videoStartOffsetMs: 0,
    })
    expect(kf[0]).toMatchObject({ autoWaitSec: 0, travelSec: 0.004 })
  })

  it('leaves a click as it was', () => {
    const kf = buildTrajectory({
      actions: [{ point: { x: 5, y: 5 }, startTime: 1000, endTime: 1400, method: 'click', params: {} }],
      videoStartOffsetMs: 0,
    })
    expect(kf[0]).toEqual({ x: 5, y: 5, videoTimeSec: 1.4, autoWaitSec: 0.4, traceMs: 1400 })
  })

  it('shows a wheel turn at the last pointer position', () => {
    const kf = buildTrajectory({
      actions: [
        { point: { x: 7, y: 8 }, startTime: 1000, method: 'mouseMove', params: {} },
        { startTime: 2000, endTime: 2010, method: 'mouseWheel', params: { deltaX: 0, deltaY: -120 } },
      ],
      videoStartOffsetMs: 0,
    })
    expect(kf).toHaveLength(2)
    expect(kf[1]).toMatchObject({ x: 7, y: 8, videoTimeSec: 2.01 })
  })

  it('skips a wheel turn before any pointer position', () => {
    const kf = buildTrajectory({
      actions: [{ startTime: 2000, method: 'mouseWheel', params: { deltaY: 120 } }],
      videoStartOffsetMs: 0,
    })
    expect(kf).toEqual([])
  })
})
