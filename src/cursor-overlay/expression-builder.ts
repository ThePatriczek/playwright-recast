import type { CursorKeyframe } from '../types/cursor-overlay.js'
import type { ResolvedCursorOverlayConfig } from './defaults.js'
import { searchBranches, type Branch } from '../utils/expression-search.js'

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

/** One move of the cursor and how long it stays, in output seconds. */
export interface CursorSegment {
  /** Viewport-scaled target */
  x: number
  y: number
  /** Arrival */
  t: number
  /** Movement start */
  moveStart: number
  /** Window end: hidden after this */
  end: number
  /** False: appear at the target, no glide */
  glide: boolean
  /** Moves at the pointer's own (linear) pace */
  linear: boolean
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
 * The cursor's segments: each recorded pointer position is reached at its
 * trace timestamp. Movement starts at the previous position and lasts no
 * longer than moveDurationMs, except a stepped move, which takes its own
 * recorded time. A held button keeps the cursor up until the next segment.
 */
export function cursorSegments(
  keyframes: CursorKeyframe[],
  config: ResolvedCursorOverlayConfig,
  scale: { x: number; y: number } = { x: 1, y: 1 },
): CursorSegment[] {
  const configuredDuration = Math.max(MIN_MOVE_DURATION, config.moveDurationMs / 1000)
  const visibleAfter = Math.max(0, config.hideAfterMs / 1000)
  const times = keyframes.map(kf => Number(kf.videoTimeSec.toFixed(4)))

  const segments = keyframes.map((kf, i) => {
    const t = times[i]!
    const lead = appearLead(kf.autoWaitSec)
    const glideDuration = Math.min(configuredDuration, lead)
    const travel = kf.travelSec ?? 0
    const linear = travel > glideDuration
    let duration = linear ? travel : glideDuration
    if (i > 0) duration = Math.min(duration, Math.max(MIN_MOVE_DURATION, t - times[i - 1]!))
    return {
      x: Math.max(0, Math.round(kf.x * scale.x)),
      y: Math.max(0, Math.round(kf.y * scale.y)),
      t,
      moveStart: Number((t - duration).toFixed(4)),
      end: t + visibleAfter,
      // When the target only appeared after a wait (a page load), there is no
      // stable context to glide across — a slide-in would travel over the
      // still-loading screen. Drop the approach and let the cursor appear
      // directly at the target instead.
      glide: (kf.autoWaitSec ?? 0) <= APPEAR_BEFORE - MIN_LEAD,
      linear,
    }
  })
  // Window ends still grow in keyframe order: a held one ends no later than
  // the next one starts moving.
  segments.forEach((seg, i) => {
    const next = segments[i + 1]
    if (keyframes[i]!.held && next) seg.end = Math.max(seg.end, next.moveStart)
  })
  return segments
}

/**
 * Build ffmpeg overlay x/y expressions for animated cursor movement.
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
  const segments = cursorSegments(keyframes, config, { x: scaleX, y: scaleY })

  return {
    x: buildTrajectoryAxis(segments, 'x', scaleX, config),
    y: buildTrajectoryAxis(segments, 'y', scaleY, config),
  }
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

const windowExpr = (seg: CursorSegment): string =>
  `between(t\\,${seg.moveStart.toFixed(4)}\\,${seg.end.toFixed(4)})`

function buildTrajectoryAxis(
  segments: CursorSegment[],
  axis: 'x' | 'y',
  scale: number,
  config: ResolvedCursorOverlayConfig,
): string {
  const initialOffset = Math.round(INITIAL_OFFSET * scale)
  const branches: Branch[] = segments.map((seg, i) => {
    const target = seg[axis]
    const previous = i === 0 ? target - initialOffset : segments[i - 1]![axis]
    // A target that appeared only after a long auto-wait has no stable page
    // context to glide across, so retain the existing appear-at-target guard.
    const start = seg.glide ? previous : target
    const duration = seg.t - seg.moveStart
    const progress = progressExpression(seg.linear ? 'linear' : config.easing)
    const moveStart = seg.moveStart.toFixed(4)
    const segment =
      `if(between(t\\,${moveStart}\\,${seg.t.toFixed(4)})\\,` +
      `st(0\\,(t-${moveStart})/${duration.toFixed(4)})\\;` +
      `${start}+(${target - start})*${progress}\\,` +
      `${target})`
    return {
      before: `lt(t\\,${moveStart})`,
      expr: `if(${windowExpr(seg)}\\,${segment}\\,0)`,
    }
  })

  // Equivalent to a chain of one if() per keyframe because movement starts
  // and window ends both grow in keyframe order: the last branch that has
  // started is the one the chain matched first, and past its window every
  // earlier window has closed too.
  return searchBranches(branches, '\\,')
}

/**
 * Cursor is visible while travelling to each position and until hideAfterMs
 * after it arrives, or while a button is held.
 */
export function buildEnableExpression(
  keyframes: CursorKeyframe[],
  config: ResolvedCursorOverlayConfig,
): string {
  if (keyframes.length === 0) return '0'
  return cursorSegments(keyframes, config).map(windowExpr).join('+')
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
