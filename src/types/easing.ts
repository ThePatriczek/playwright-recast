/** Built-in easing preset names */
export type EasingPreset = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

/**
 * Easing specification for zoom transitions.
 * - String preset: uses built-in analytic ffmpeg expression (exact, compact)
 * - cubicBezier: pre-sampled via Newton's method, piecewise-linear in expression
 * - fn: custom JS function, pre-sampled, piecewise-linear in expression
 */
export type EasingSpec =
  | EasingPreset
  | { cubicBezier: [number, number, number, number] }
  | { fn: (t: number) => number }
