import type { CursorKeyframe } from '../types/cursor-overlay.js'
import type { ResolvedCursorOverlayConfig } from './defaults.js'

interface Resolution {
  width: number
  height: number
}

/** Default pre-click lead used to avoid animating across a loading page. */
const APPEAR_BEFORE = 0.5
/** Offset in viewport px used before the first recorded pointer position. */
const INITIAL_OFFSET = 40
/** Smallest pre-click lead, even when the target appeared at the last moment */
const MIN_LEAD = 0.15
/** Keep ffmpeg interpolation denominators non-zero for coincident positions. */
const MIN_MOVE_DURATION = 0.05

interface TrajectoryPoint {
  x: number
  y: number
  t: number
  lead: number
  glide: boolean
}

/**
 * How long before a click the cursor should appear, trimmed by the action's
 * auto-wait. If the click waited on a page load, the target only became
 * visible near the click moment, so a full APPEAR_BEFORE lead would glide the
 * cursor over the still-loading screen. Subtracting the wait keeps the cursor
 * from appearing before the target does (clamped to MIN_LEAD).
 */
function appearLead(autoWaitSec: number | undefined): number {
  return Math.max(MIN_LEAD, APPEAR_BEFORE - (autoWaitSec ?? 0))
}

/**
 * Build ffmpeg overlay x/y expressions for animated cursor movement.
 * Each recorded pointer position is reached at its trace timestamp. Movement
 * starts at the previous position and lasts no longer than moveDurationMs.
 */
export function buildOverlayExpressions(
  keyframes: CursorKeyframe[],
  config: ResolvedCursorOverlayConfig,
  viewport: Resolution,
  srcRes: Resolution,
): { x: string; y: string } {
  if (keyframes.length === 0) {
    return { x: '0', y: '0' }
  }

  const scaleX = srcRes.width / viewport.width
  const scaleY = srcRes.height / viewport.height

  const points = keyframes.map(kf => {
    const lead = appearLead(kf.autoWaitSec)
    // When the target only appeared after a wait (a page load), there is no
    // stable context to glide across — a slide-in would travel over the
    // still-loading screen. Drop the approach and let the cursor appear
    // directly at the target instead.
    const glide = (kf.autoWaitSec ?? 0) <= APPEAR_BEFORE - MIN_LEAD
    return {
      x: Math.max(0, Math.round(kf.x * scaleX)),
      y: Math.max(0, Math.round(kf.y * scaleY)),
      t: Number(kf.videoTimeSec.toFixed(4)),
      lead,
      glide,
    }
  })

  return {
    x: buildTrajectoryAxis(points, 'x', scaleX, config),
    y: buildTrajectoryAxis(points, 'y', scaleY, config),
  }
}

function moveDuration(
  points: Array<Pick<TrajectoryPoint, 't' | 'lead'>>,
  index: number,
  configuredDuration: number,
): number {
  const available = index === 0
    ? configuredDuration
    : Math.max(MIN_MOVE_DURATION, points[index]!.t - points[index - 1]!.t)
  return Math.min(configuredDuration, points[index]!.lead, available)
}

function progressExpression(easing: ResolvedCursorOverlayConfig['easing']): string {
  switch (easing) {
    case 'linear':
      return 'ld(0)'
    case 'ease-out':
      return '(1-(1-ld(0))*(1-ld(0)))'
    case 'ease-in-out':
    default:
      return '(3*ld(0)*ld(0)-2*ld(0)*ld(0)*ld(0))'
  }
}

function buildTrajectoryAxis(
  points: TrajectoryPoint[],
  axis: 'x' | 'y',
  scale: number,
  config: ResolvedCursorOverlayConfig,
): string {
  if (points.length === 0) return '0'

  const configuredDuration = Math.max(MIN_MOVE_DURATION, config.moveDurationMs / 1000)
  const visibleAfter = Math.max(0, config.hideAfterMs / 1000)
  const initialOffset = Math.round(INITIAL_OFFSET * scale)
  const easedProgress = progressExpression(config.easing)
  const branches: Branch[] = []

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!
    const target = point[axis]
    const previous = i === 0 ? target - initialOffset : points[i - 1]![axis]
    // A target that appeared only after a long auto-wait has no stable page
    // context to glide across, so retain the existing appear-at-target guard.
    const start = point.glide ? previous : target
    const duration = moveDuration(points, i, configuredDuration)
    const moveStart = point.t - duration
    const segment =
      `if(between(t\\,${moveStart.toFixed(4)}\\,${point.t.toFixed(4)})\\,` +
      `st(0\\,(t-${moveStart.toFixed(4)})/${duration.toFixed(4)})\\;` +
      `${start}+(${target - start})*${easedProgress}\\,` +
      `${target})`

    branches.push({
      from: moveStart,
      expr:
        `if(between(t\\,${moveStart.toFixed(4)}\\,${(point.t + visibleAfter).toFixed(4)})\\,${segment}\\,0)`,
    })
  }

  return buildBranchSearch(branches, 0, branches.length - 1)
}

/** One keyframe's position expression, keyed by the time its movement starts. */
interface Branch {
  from: number
  expr: string
}

/**
 * Bisect on movement start times instead of chaining one `if()` per keyframe:
 * ffmpeg's expression parser allows ~100 nesting levels (libavutil/eval.c), so
 * a chain stopped parsing past ~96 keyframes. Nesting is now log2(keyframes).
 *
 * Equivalent to the chain because movement starts and window ends both grow in
 * keyframe order: the last branch that has started is the one the chain
 * matched first, and past its window every earlier window has closed too.
 */
function buildBranchSearch(branches: Branch[], lo: number, hi: number): string {
  if (lo === hi) return branches[lo]!.expr

  // Right half keeps `mid`, so coincident start times resolve to the later
  // keyframe — the one the chain gave priority to.
  const mid = Math.ceil((lo + hi) / 2)
  const left = buildBranchSearch(branches, lo, mid - 1)
  const right = buildBranchSearch(branches, mid, hi)
  return `if(lt(t\\,${branches[mid]!.from.toFixed(4)})\\,${left}\\,${right})`
}

/**
 * Cursor is visible while travelling to each position and until hideAfterMs
 * after it arrives.
 */
export function buildEnableExpression(
  keyframes: CursorKeyframe[],
  config: ResolvedCursorOverlayConfig,
): string {
  if (keyframes.length === 0) return '0'

  const configuredDuration = Math.max(MIN_MOVE_DURATION, config.moveDurationMs / 1000)
  const visibleAfter = Math.max(0, config.hideAfterMs / 1000)
  const points = keyframes.map(kf => ({
    t: Number(kf.videoTimeSec.toFixed(4)),
    lead: appearLead(kf.autoWaitSec),
  }))
  const windows = points.map((point, index) => {
    const duration = moveDuration(points, index, configuredDuration)
    const start = (point.t - duration).toFixed(4)
    const end = (point.t + visibleAfter).toFixed(4)
    return `between(t\\,${start}\\,${end})`
  })

  return windows.join('+')
}

// Keep for backwards compat with tests
export interface FadeTiming {
  firstT: number
  fadeOutStartT: number
  fadeInDur: number
  fadeOutDur: number
}

export function buildFadeTiming(): null {
  return null
}
