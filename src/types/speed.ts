import type { MonotonicMs, TraceAction, TraceResource, FilteredTrace } from './trace'

/** A contiguous time segment with a single speed multiplier */
export interface SpeedSegment {
  originalStart: MonotonicMs
  originalEnd: MonotonicMs
  /** Speed multiplier (1.0 = real-time, 2.0 = 2x faster) */
  speed: number
  /** Mapped output time (after speed adjustment) */
  outputStart: number
  outputEnd: number
}

/** Maps original trace time to output video time */
export type TimeRemapFn = (originalTime: MonotonicMs) => number

/** Activity type for a time range */
export type ActivityType = 'user-action' | 'navigation' | 'network-wait' | 'idle'

/** Context passed to custom speed rules */
export interface SpeedRuleContext {
  time: MonotonicMs
  activeActions: TraceAction[]
  activeRequests: TraceResource[]
  timeSinceLastAction: number
  timeUntilNextAction: number
  activityType: ActivityType
}

/** Custom speed rule (first match wins) */
export interface SpeedRule {
  name: string
  match: (context: SpeedRuleContext) => boolean
  speed: number
}

/** Speed processing configuration */
export interface SpeedConfig {
  /** Speed during idle periods (no actions, no network). Default: 4.0 */
  duringIdle?: number
  /** Speed during user actions. Default: 1.0 */
  duringUserAction?: number
  /** Speed while waiting for network responses. Default: 2.0 */
  duringNetworkWait?: number
  /** Speed during navigation/page load. Default: 2.0 */
  duringNavigation?: number
  /** Minimum segment duration (ms) before speed change. Default: 500 */
  minSegmentDuration?: number
  /** Maximum speed multiplier. Default: 8.0 */
  maxSpeed?: number
  /** Custom rules (evaluated first, first match wins) */
  rules?: SpeedRule[]
}

/** Trace after speed processing has been applied */
export interface SpeedMappedTrace extends FilteredTrace {
  speedSegments: SpeedSegment[]
  timeRemap: TimeRemapFn
  outputDuration: number
}
