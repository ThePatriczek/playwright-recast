import type { FilteredTrace, TraceAction, TraceResource } from '../types/trace.js'
import { toMonotonic } from '../types/trace.js'
import type { SpeedConfig, SpeedSegment, SpeedMappedTrace, SpeedRuleContext } from '../types/speed.js'
import { classifyTimepoint, USER_ACTION_METHODS } from './classifiers.js'
import { computeOutputTimes, buildTimeRemap } from './time-remap.js'

const DEFAULTS: Required<Omit<SpeedConfig, 'rules' | 'recordingPageId' | 'postFastForwardSettleMs' | 'segments'>> = {
  duringIdle: 4.0,
  duringUserAction: 1.0,
  duringNetworkWait: 2.0,
  duringNavigation: 2.0,
  minSegmentDuration: 500,
  maxSpeed: 100.0,
}

function speedForActivity(
  activity: string,
  config: SpeedConfig,
): number {
  const c = { ...DEFAULTS, ...config }
  switch (activity) {
    case 'user-action': return c.duringUserAction
    case 'navigation': return c.duringNavigation
    case 'network-wait': return c.duringNetworkWait
    case 'idle': return c.duringIdle
    default: return 1.0
  }
}

/**
 * Pre-compute sorted user action boundaries for efficient
 * timeSinceLastAction / timeUntilNextAction lookups.
 *
 * When recordingPageId is provided, only actions from that page are considered.
 * This prevents setup-context actions from polluting the user action timeline.
 */
function buildUserActionTimeline(
  actions: TraceAction[],
  recordingPageId?: string,
): { ends: number[]; starts: number[] } {
  const userActions = actions.filter((a) => {
    if (!USER_ACTION_METHODS.has(a.method)) return false
    if (recordingPageId && a.pageId && a.pageId !== recordingPageId) return false
    return true
  })
  return {
    ends: userActions.map((a) => a.endTime as number).sort((a, b) => a - b),
    starts: userActions.map((a) => a.startTime as number).sort((a, b) => a - b),
  }
}

function timeSinceLastUserAction(t: number, sortedEnds: number[]): number {
  // Binary search for the last end time <= t
  let lo = 0, hi = sortedEnds.length - 1, best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (sortedEnds[mid]! <= t) { best = mid; lo = mid + 1 }
    else { hi = mid - 1 }
  }
  return best >= 0 ? t - sortedEnds[best]! : Infinity
}

function timeUntilNextUserAction(t: number, sortedStarts: number[]): number {
  // Binary search for the first start time > t
  let lo = 0, hi = sortedStarts.length - 1, best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (sortedStarts[mid]! > t) { best = mid; hi = mid - 1 }
    else { lo = mid + 1 }
  }
  return best >= 0 ? sortedStarts[best]! - t : Infinity
}

/**
 * Process a trace into speed segments based on activity classification.
 * Evaluates custom rules first (first match wins), then falls back to
 * built-in classification. Merges adjacent same-speed segments and
 * applies minSegmentDuration filtering.
 */
export function processSpeed(
  trace: FilteredTrace,
  config: SpeedConfig,
): SpeedMappedTrace {
  const c = { ...DEFAULTS, ...config }
  const { actions, resources, hiddenRanges } = trace
  const rules = config.rules ?? []

  // Determine time boundaries from visible content
  const visibleStart = trace.metadata.startTime as number
  const visibleEnd = trace.metadata.endTime as number

  if (visibleEnd <= visibleStart) {
    return {
      ...trace,
      speedSegments: [],
      timeRemap: () => 0,
      outputDuration: 0,
    }
  }

  // Explicit segments mode: caller provides pre-built segments (e.g., voiceover-driven).
  // Convert from SRT-time-based segments to trace-monotonic SpeedSegments.
  if (config.segments && config.segments.length > 0) {
    // Determine the recording page's first frame as the SRT time baseline
    const recPageId = trace.frames.length > 0
      ? trace.frames[trace.frames.length - 1]!.pageId : undefined
    const recFrames = recPageId
      ? trace.frames.filter((f) => f.pageId === recPageId) : trace.frames
    const recActions = trace.actions.filter((a) => a.pageId === recPageId)
    const baseline = recActions.length > 0
      ? (recActions[0]!.startTime as number)
      : recFrames.length > 0
        ? (recFrames[0]!.timestamp as number)
        : visibleStart

    const speedSegments: SpeedSegment[] = config.segments.map((seg) => ({
      originalStart: toMonotonic(seg.startMs + baseline),
      originalEnd: toMonotonic(seg.endMs + baseline),
      speed: seg.speed,
      outputStart: 0,
      outputEnd: 0,
    }))

    const withOutputTimes = computeOutputTimes(speedSegments)
    const timeRemap = buildTimeRemap(withOutputTimes)
    const outputDuration = withOutputTimes.length > 0
      ? withOutputTimes[withOutputTimes.length - 1]!.outputEnd : 0

    return {
      ...trace,
      speedSegments: withOutputTimes,
      timeRemap,
      outputDuration,
      postFastForwardSettleMs: config.postFastForwardSettleMs,
    }
  }

  // Auto-detect recording page ID from the page that has the LAST screencast frame
  // (the recording context runs longest). Using frames[0] is wrong — it may be
  // from a hidden setup context that was created before the recording context.
  const recordingPageId = config.recordingPageId ??
    (trace.frames.length > 0
      ? trace.frames[trace.frames.length - 1]!.pageId
      : undefined)

  // Pre-compute user action timeline for rule context
  const userTimeline = buildUserActionTimeline(actions, recordingPageId)

  // Sample at regular intervals to classify activity
  const sampleInterval = 100 // ms
  const rawSegments: Array<{ start: number; end: number; speed: number }> = []

  for (let t = visibleStart; t < visibleEnd; t += sampleInterval) {
    // Skip hidden ranges
    const isHidden = hiddenRanges.some(
      (r) => t >= (r.start as number) && t < (r.end as number),
    )
    if (isHidden) continue

    const mono = toMonotonic(t)
    const activityType = classifyTimepoint(mono, actions, resources)
    let speed: number

    // Evaluate custom rules first (first match wins)
    if (rules.length > 0) {
      const activeActions = actions.filter(
        (a) => (t >= (a.startTime as number)) && (t <= (a.endTime as number)),
      )
      const activeRequests = resources.filter(
        (r) => (t >= (r.startTime as number)) && (t <= (r.endTime as number)),
      )

      const ctx: SpeedRuleContext = {
        time: mono,
        activeActions,
        activeRequests,
        timeSinceLastAction: timeSinceLastUserAction(t, userTimeline.ends),
        timeUntilNextAction: timeUntilNextUserAction(t, userTimeline.starts),
        activityType,
      }

      const matchedRule = rules.find((r) => r.match(ctx))
      if (matchedRule) {
        speed = matchedRule.speed
      } else {
        speed = Math.min(speedForActivity(activityType, config), c.maxSpeed)
      }
    } else {
      speed = Math.min(speedForActivity(activityType, config), c.maxSpeed)
    }

    const segEnd = Math.min(t + sampleInterval, visibleEnd)

    if (rawSegments.length > 0) {
      const last = rawSegments[rawSegments.length - 1]!
      if (last.speed === speed && last.end === t) {
        last.end = segEnd
        continue
      }
    }

    rawSegments.push({ start: t, end: segEnd, speed })
  }

  // Apply minSegmentDuration: merge short segments into neighbors
  const merged: typeof rawSegments = []
  for (const seg of rawSegments) {
    if (merged.length > 0) {
      const last = merged[merged.length - 1]!
      if (seg.end - seg.start < c.minSegmentDuration) {
        // Merge into previous segment (use slower speed to avoid jarring)
        last.end = seg.end
        last.speed = Math.min(last.speed, seg.speed)
        continue
      }
    }
    merged.push({ ...seg })
  }

  // Convert to SpeedSegment[]
  const speedSegments: SpeedSegment[] = merged.map((seg) => ({
    originalStart: toMonotonic(seg.start),
    originalEnd: toMonotonic(seg.end),
    speed: seg.speed,
    outputStart: 0,
    outputEnd: 0,
  }))

  // Compute output times and build remap function
  const withOutputTimes = computeOutputTimes(speedSegments)
  const timeRemap = buildTimeRemap(withOutputTimes)
  const outputDuration =
    withOutputTimes.length > 0
      ? withOutputTimes[withOutputTimes.length - 1]!.outputEnd
      : 0

  return {
    ...trace,
    speedSegments: withOutputTimes,
    timeRemap,
    outputDuration,
    postFastForwardSettleMs: config.postFastForwardSettleMs,
  }
}
