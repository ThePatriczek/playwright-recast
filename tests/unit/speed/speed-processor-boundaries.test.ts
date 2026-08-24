import { describe, it, expect } from 'vitest'
import { buildSamplePoints } from '../../../src/speed/sample-points'

describe('exactBoundaries produces intervals, not grid cells', () => {
  it('an interval never spans a boundary when the flag is on', () => {
    // The classifier walks points pairwise; no interval may contain a
    // boundary in its interior, or the scene on one side gets the other
    // side's speed.
    const boundaries = [237, 456, 460]
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 600, sampleInterval: 100,
      exactBoundaries: true, boundaryTimes: boundaries,
    })
    for (let i = 0; i < points.length - 1; i++) {
      const [lo, hi] = [points[i]!, points[i + 1]!]
      for (const b of boundaries) {
        expect(b > lo && b < hi).toBe(false)
      }
    }
  })

  it('with the flag off, intervals are exactly the old grid cells', () => {
    // Regression guard for the non-breaking requirement.
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 450, sampleInterval: 100,
      exactBoundaries: false, boundaryTimes: [237, 456],
    })
    const intervals = points.slice(0, -1).map((t, i) => [t, points[i + 1]!])
    expect(intervals).toEqual([[0, 100], [100, 200], [200, 300], [300, 400], [400, 450]])
  })
})
