import type { EasingSpec } from '../types/easing.js'

/**
 * Analytic easing — produces an ffmpeg sub-expression from a normalized parameter expression.
 * The `expr` function takes a string like `ld(0)` and returns the eased value as ffmpeg math.
 */
export interface AnalyticEasing {
  mode: 'analytic'
  expr: (p: string) => string
}

/**
 * Sampled easing — a JS function (t: 0..1) → (0..1) that will be pre-evaluated
 * and encoded as piecewise-linear segments in the ffmpeg expression.
 */
export interface SampledEasing {
  mode: 'sampled'
  fn: (t: number) => number
}

export type ResolvedEasing = AnalyticEasing | SampledEasing

/**
 * Resolve an EasingSpec into either an analytic or sampled easing.
 */
export function resolveEasing(spec: EasingSpec): ResolvedEasing {
  if (typeof spec === 'string') {
    switch (spec) {
      case 'linear':
        return { mode: 'analytic', expr: (p) => p }
      case 'ease-in':
        return { mode: 'analytic', expr: (p) => `${p}*${p}` }
      case 'ease-out':
        return { mode: 'analytic', expr: (p) => `(1-(1-${p})*(1-${p}))` }
      case 'ease-in-out':
        return { mode: 'analytic', expr: (p) => `(3*${p}*${p}-2*${p}*${p}*${p})` }
    }
  }
  if ('cubicBezier' in spec) {
    const [x1, y1, x2, y2] = spec.cubicBezier
    return { mode: 'sampled', fn: cubicBezierFn(x1, y1, x2, y2) }
  }
  return { mode: 'sampled', fn: spec.fn }
}

/**
 * Create a cubic-bezier easing function.
 * Solves B(t) for x, then returns y at that t.
 * Uses Newton's method to find t given x.
 */
export function cubicBezierFn(
  x1: number, y1: number, x2: number, y2: number,
): (x: number) => number {
  // Cubic bezier basis functions
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx

  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by

  function sampleX(t: number): number {
    return ((ax * t + bx) * t + cx) * t
  }

  function sampleY(t: number): number {
    return ((ay * t + by) * t + cy) * t
  }

  function sampleDerivX(t: number): number {
    return (3 * ax * t + 2 * bx) * t + cx
  }

  function solveTForX(x: number): number {
    // Newton's method
    let t = x
    for (let i = 0; i < 8; i++) {
      const currentX = sampleX(t) - x
      const deriv = sampleDerivX(t)
      if (Math.abs(currentX) < 1e-7) break
      if (Math.abs(deriv) < 1e-7) break
      t -= currentX / deriv
    }
    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, t))
  }

  return (x: number): number => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    return sampleY(solveTForX(x))
  }
}
