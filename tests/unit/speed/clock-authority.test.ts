import { describe, it, expect } from 'vitest'
import { isSpeedClockAuthority } from '../../../src/speed/clock-authority'
import { toMonotonic } from '../../../src/types/trace'
import type { SpeedSegment } from '../../../src/types/speed'

const seg = (speed: number): SpeedSegment => ({
  originalStart: toMonotonic(0),
  originalEnd: toMonotonic(1000),
  speed,
  outputStart: 0,
  outputEnd: 0,
})

describe('isSpeedClockAuthority', () => {
  it('is false when there is no speed map at all', () => {
    expect(isSpeedClockAuthority(undefined)).toBe(false)
  })

  it('is false for an empty segment list', () => {
    expect(isSpeedClockAuthority([])).toBe(false)
  })

  it('is false when every segment is real-time', () => {
    expect(isSpeedClockAuthority([seg(1.0), seg(1.0), seg(1.0)])).toBe(false)
  })

  it('is true when any segment is non-real-time', () => {
    expect(isSpeedClockAuthority([seg(1.0), seg(4.0), seg(1.0)])).toBe(true)
  })

  it('uses the mapped clock when hidden intervals are removed at normal speed', () => {
    const segments = [
      { ...seg(1), originalStart: toMonotonic(0), originalEnd: toMonotonic(1000), outputEnd: 1000 },
      { ...seg(1), originalStart: toMonotonic(2000), originalEnd: toMonotonic(3000), outputStart: 1000, outputEnd: 2000 },
    ]
    expect(isSpeedClockAuthority(segments)).toBe(true)
  })

  it('treats a deviation within 0.01 as real-time (matches the renderer threshold)', () => {
    expect(isSpeedClockAuthority([seg(1.005)])).toBe(false)
    expect(isSpeedClockAuthority([seg(0.995)])).toBe(false)
  })

  it('treats a deviation beyond 0.01 as non-real-time', () => {
    expect(isSpeedClockAuthority([seg(1.02)])).toBe(true)
    expect(isSpeedClockAuthority([seg(0.5)])).toBe(true)
  })
})
