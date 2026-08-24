/**
 * Build the points at which the speed classifier samples activity.
 *
 * The classifier walks these pairwise: point `i` classifies the interval
 * `[points[i], points[i + 1])`. The array therefore always ends at
 * `visibleEnd`, yielding `points.length - 1` intervals.
 *
 * With `exactBoundaries` off this is exactly the fixed grid the classifier has
 * always used — that equivalence is the non-breaking guarantee, so do not
 * "tidy" the off branch.
 *
 * With it on, narration and hidden-range boundaries join the grid, so a scene
 * shorter than one sample interval keeps its own interval instead of being
 * swallowed by the surrounding grid cell.
 */
export function buildSamplePoints(opts: {
  visibleStart: number
  visibleEnd: number
  sampleInterval: number
  exactBoundaries: boolean
  boundaryTimes: readonly number[]
}): number[] {
  const { visibleStart, visibleEnd, sampleInterval, exactBoundaries, boundaryTimes } = opts

  const points: number[] = []
  for (let t = visibleStart; t < visibleEnd; t += sampleInterval) points.push(t)
  points.push(visibleEnd)

  if (!exactBoundaries) return points

  for (const b of boundaryTimes) {
    if (b > visibleStart && b < visibleEnd) points.push(b)
  }

  return [...new Set(points)].sort((a, b) => a - b)
}
