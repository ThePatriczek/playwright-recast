import { describe, it, expect } from 'vitest'
import { buildSamplePoints } from '../../../src/speed/sample-points'

const grid = (start: number, end: number, step: number): number[] => {
  const out: number[] = []
  for (let t = start; t < end; t += step) out.push(t)
  out.push(end)
  return out
}

describe('buildSamplePoints', () => {
  it('reproduces the plain grid when exactBoundaries is off', () => {
    // The non-breaking guarantee: flag off must equal today's sampling.
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 1000, sampleInterval: 100,
      exactBoundaries: false, boundaryTimes: [237, 456],
    })
    expect(points).toEqual(grid(0, 1000, 100))
  })

  it('ignores boundaryTimes entirely when the flag is off', () => {
    const withBoundaries = buildSamplePoints({
      visibleStart: 0, visibleEnd: 500, sampleInterval: 100,
      exactBoundaries: false, boundaryTimes: [1, 2, 3, 4, 5],
    })
    const without = buildSamplePoints({
      visibleStart: 0, visibleEnd: 500, sampleInterval: 100,
      exactBoundaries: false, boundaryTimes: [],
    })
    expect(withBoundaries).toEqual(without)
  })

  it('inserts boundary times when the flag is on', () => {
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 300, sampleInterval: 100,
      exactBoundaries: true, boundaryTimes: [150, 250],
    })
    expect(points).toEqual([0, 100, 150, 200, 250, 300])
  })

  it('preserves a visible scene shorter than the sample interval', () => {
    // The defect: a 20ms scene between two boundaries vanished on the grid.
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 500, sampleInterval: 100,
      exactBoundaries: true, boundaryTimes: [230, 250],
    })
    expect(points).toContain(230)
    expect(points).toContain(250)
    const i = points.indexOf(230)
    expect(points[i + 1]).toBe(250)
  })

  it('sorts and dedupes', () => {
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 300, sampleInterval: 100,
      exactBoundaries: true, boundaryTimes: [200, 100, 200, 50],
    })
    expect(points).toEqual([0, 50, 100, 200, 300])
  })

  it('drops boundaries outside the visible range', () => {
    const points = buildSamplePoints({
      visibleStart: 100, visibleEnd: 300, sampleInterval: 100,
      exactBoundaries: true, boundaryTimes: [-50, 50, 400, 1000],
    })
    expect(points).toEqual([100, 200, 300])
  })

  it('always ends at visibleEnd', () => {
    for (const end of [250, 300, 999]) {
      const points = buildSamplePoints({
        visibleStart: 0, visibleEnd: end, sampleInterval: 100,
        exactBoundaries: true, boundaryTimes: [],
      })
      expect(points[points.length - 1]).toBe(end)
    }
  })
})
