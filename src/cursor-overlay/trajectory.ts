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

/** A trace action as the trajectory reads it. */
export interface PointerAction {
  point?: { x: number; y: number }
  startTime: number
  endTime?: number
  method?: string
  params?: Record<string, unknown>
}

export interface TrajectoryInput {
  /** Actions with point data, sorted by startTime */
  actions: ReadonlyArray<PointerAction>
  /** Optional filter for which actions to include */
  filter?: (action: { point?: { x: number; y: number }; startTime: number }) => boolean
  /** Time remap function (trace monotonic → output video ms) */
  timeRemap?: (traceTimeMs: number) => number
  /** Video start offset in ms (subtracted from remapped time) */
  videoStartOffsetMs: number
}

/** `mouse.move()` never auto-waits: its span is the pointer walking there, linearly over its steps. */
const isPointerMove = (a: PointerAction): boolean => a.method === 'mouseMove'

/**
 * Build a trajectory of cursor keyframes from trace actions.
 * Extracts actions with cursor positions and converts to video-time keyframes.
 * A wheel turn, which has no point of its own, shows at the last pointer position.
 */
export function buildTrajectory(input: TrajectoryInput): CursorKeyframe[] {
  const remap = input.timeRemap ?? ((t: number) => t)
  const sorted = [...input.actions].sort((a, b) => a.startTime - b.startTime)
  const keyframes: CursorKeyframe[] = []
  let last: { x: number; y: number } | undefined
  const down = new Set<string>()

  for (const action of sorted) {
    const point = action.point ?? (action.method === 'mouseWheel' ? last : undefined)
    if (action.method === 'mouseDown') down.add(String(action.params?.button ?? 'left'))
    if (action.method === 'mouseUp') down.delete(String(action.params?.button ?? 'left'))
    if (!point) continue
    last = point
    if (input.filter && !input.filter({ ...action, point })) continue

    // Use the action's END time: with Playwright auto-wait, an action that
    // targets an element still loading completes (and the cursor visually
    // lands) at endTime, which can be seconds after startTime. Positioning
    // the cursor at startTime makes it arrive before the target is visible.
    const actionTime = action.endTime ?? action.startTime
    const videoTimeMs = remap(actionTime) - input.videoStartOffsetMs
    const spanMs = Math.max(0, remap(actionTime) - remap(action.startTime))
    const stepped = isPointerMove(action)

    keyframes.push({
      x: point.x,
      y: point.y,
      videoTimeSec: Math.max(0, videoTimeMs / 1000),
      // A pointer move's span is the pointer travelling, visible on the page
      // (a drag draws as it goes). Any other span is auto-wait: the target was
      // unavailable, so the cursor's pre-click approach is trimmed by it.
      autoWaitSec: stepped ? 0 : spanMs / 1000,
      traceMs: actionTime,
      ...(stepped ? { travelSec: spanMs / 1000, travelTraceMs: action.startTime } : {}),
      ...(down.size > 0 ? { held: true } : {}),
    })
  }

  keyframes.sort((a, b) => a.videoTimeSec - b.videoTimeSec)
  return keyframes
}
