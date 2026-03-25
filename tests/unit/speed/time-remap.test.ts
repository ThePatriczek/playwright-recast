import { describe, it, expect } from 'vitest'
import { buildTimeRemap, computeOutputTimes } from '../../../src/speed/time-remap'
import { toMonotonic } from '../../../src/types/trace'
import type { SpeedSegment } from '../../../src/types/speed'

describe('Time Remap', () => {
  describe('computeOutputTimes', () => {
    it('computes output times for a single 1x segment', () => {
      const segments: SpeedSegment[] = [
        {
          originalStart: toMonotonic(0),
          originalEnd: toMonotonic(10000),
          speed: 1.0,
          outputStart: 0,
          outputEnd: 0,
        },
      ]
      const result = computeOutputTimes(segments)
      expect(result[0]!.outputStart).toBe(0)
      expect(result[0]!.outputEnd).toBe(10000)
    })

    it('computes output times for a 2x segment (halves duration)', () => {
      const segments: SpeedSegment[] = [
        {
          originalStart: toMonotonic(0),
          originalEnd: toMonotonic(10000),
          speed: 2.0,
          outputStart: 0,
          outputEnd: 0,
        },
      ]
      const result = computeOutputTimes(segments)
      expect(result[0]!.outputStart).toBe(0)
      expect(result[0]!.outputEnd).toBe(5000)
    })

    it('chains multiple segments cumulatively', () => {
      const segments: SpeedSegment[] = [
        {
          originalStart: toMonotonic(0),
          originalEnd: toMonotonic(4000),
          speed: 1.0,
          outputStart: 0,
          outputEnd: 0,
        },
        {
          originalStart: toMonotonic(4000),
          originalEnd: toMonotonic(12000),
          speed: 4.0,
          outputStart: 0,
          outputEnd: 0,
        },
        {
          originalStart: toMonotonic(12000),
          originalEnd: toMonotonic(15000),
          speed: 1.0,
          outputStart: 0,
          outputEnd: 0,
        },
      ]
      const result = computeOutputTimes(segments)
      expect(result[0]!.outputStart).toBe(0)
      expect(result[0]!.outputEnd).toBe(4000)
      expect(result[1]!.outputStart).toBe(4000)
      expect(result[1]!.outputEnd).toBe(6000)
      expect(result[2]!.outputStart).toBe(6000)
      expect(result[2]!.outputEnd).toBe(9000)
    })
  })

  describe('buildTimeRemap', () => {
    it('maps time within a single segment', () => {
      const segments: SpeedSegment[] = computeOutputTimes([
        {
          originalStart: toMonotonic(0),
          originalEnd: toMonotonic(10000),
          speed: 2.0,
          outputStart: 0,
          outputEnd: 0,
        },
      ])
      const remap = buildTimeRemap(segments)

      expect(remap(toMonotonic(0))).toBe(0)
      expect(remap(toMonotonic(5000))).toBe(2500)
      expect(remap(toMonotonic(10000))).toBe(5000)
    })

    it('maps time across multiple segments', () => {
      const segments = computeOutputTimes([
        {
          originalStart: toMonotonic(0),
          originalEnd: toMonotonic(4000),
          speed: 1.0,
          outputStart: 0,
          outputEnd: 0,
        },
        {
          originalStart: toMonotonic(4000),
          originalEnd: toMonotonic(12000),
          speed: 4.0,
          outputStart: 0,
          outputEnd: 0,
        },
      ])
      const remap = buildTimeRemap(segments)

      // In first segment (1x): 2000 → 2000
      expect(remap(toMonotonic(2000))).toBe(2000)
      // At boundary: 4000 → 4000
      expect(remap(toMonotonic(4000))).toBe(4000)
      // In second segment (4x): 8000 is 4000ms into second segment → 4000 + 1000 = 5000
      expect(remap(toMonotonic(8000))).toBe(5000)
    })

    it('clamps before first segment to 0', () => {
      const segments = computeOutputTimes([
        {
          originalStart: toMonotonic(1000),
          originalEnd: toMonotonic(5000),
          speed: 1.0,
          outputStart: 0,
          outputEnd: 0,
        },
      ])
      const remap = buildTimeRemap(segments)
      expect(remap(toMonotonic(0))).toBe(0)
    })

    it('clamps after last segment to total output duration', () => {
      const segments = computeOutputTimes([
        {
          originalStart: toMonotonic(0),
          originalEnd: toMonotonic(4000),
          speed: 2.0,
          outputStart: 0,
          outputEnd: 0,
        },
      ])
      const remap = buildTimeRemap(segments)
      // 4000 at 2x = 2000 output. Time 5000 should clamp to 2000.
      expect(remap(toMonotonic(5000))).toBe(2000)
    })
  })
})
