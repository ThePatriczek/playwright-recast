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
    expect(result[0]).toEqual({ x: 100, y: 200, videoTimeSec: 1 })
    expect(result[1]).toEqual({ x: 300, y: 400, videoTimeSec: 3 })
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
