import type { CursorKeyframe } from '../types/cursor-overlay.js'

/** Linear interpolation — no easing */
export function linear(t: number): number {
  return t
}

/** Smoothstep (ease-in-out): 3t² - 2t³ */
export function easeInOut(t: number): number {
  return 3 * t * t - 2 * t * t * t
}

/** Quadratic ease-out: 1 - (1-t)² */
export function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t)
}

export type EasingFn = (t: number) => number

/** Map easing name to function */
export function getEasingFn(type: 'linear' | 'ease-in-out' | 'ease-out'): EasingFn {
  switch (type) {
    case 'linear': return linear
    case 'ease-in-out': return easeInOut
    case 'ease-out': return easeOut
  }
}

export interface TrajectoryInput {
  /** Actions with point data, sorted by startTime */
  actions: ReadonlyArray<{
    point?: { x: number; y: number }
    startTime: number
  }>
  /** Optional filter for which actions to include */
  filter?: (action: { point?: { x: number; y: number }; startTime: number }) => boolean
  /** Time remap function (trace monotonic → output video ms) */
  timeRemap?: (traceTimeMs: number) => number
  /** Video start offset in ms (subtracted from remapped time) */
  videoStartOffsetMs: number
}

/**
 * Build a trajectory of cursor keyframes from trace actions.
 * Extracts actions with cursor positions and converts to video-time keyframes.
 */
export function buildTrajectory(input: TrajectoryInput): CursorKeyframe[] {
  let actions = input.actions.filter(a => a.point)

  if (input.filter) {
    actions = actions.filter(input.filter)
  }

  const keyframes: CursorKeyframe[] = actions.map(action => {
    let videoTimeMs: number
    if (input.timeRemap) {
      videoTimeMs = input.timeRemap(action.startTime) - input.videoStartOffsetMs
    } else {
      videoTimeMs = action.startTime - input.videoStartOffsetMs
    }

    return {
      x: action.point!.x,
      y: action.point!.y,
      videoTimeSec: Math.max(0, videoTimeMs / 1000),
    }
  })

  // Sort by time and deduplicate near-identical timestamps (within 50ms)
  keyframes.sort((a, b) => a.videoTimeSec - b.videoTimeSec)

  return keyframes
}
