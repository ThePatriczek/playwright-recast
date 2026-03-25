import type { FilteredTrace } from '../types/trace'
import { toMonotonic } from '../types/trace'
import type { SpeedConfig, SpeedSegment, SpeedMappedTrace } from '../types/speed'
import { classifyTimepoint } from './classifiers'
import { computeOutputTimes, buildTimeRemap } from './time-remap'

const DEFAULTS: Required<Omit<SpeedConfig, 'rules'>> = {
  duringIdle: 4.0,
  duringUserAction: 1.0,
  duringNetworkWait: 2.0,
  duringNavigation: 2.0,
  minSegmentDuration: 500,
  maxSpeed: 8.0,
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
 * Process a trace into speed segments based on activity classification.
 * Classifies each time interval, merges adjacent same-speed segments,
 * and applies minSegmentDuration filtering.
 */
export function processSpeed(
  trace: FilteredTrace,
  config: SpeedConfig,
): SpeedMappedTrace {
  const c = { ...DEFAULTS, ...config }
  const { actions, resources, hiddenRanges } = trace

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

  // Sample at regular intervals to classify activity
  const sampleInterval = 100 // ms
  const rawSegments: Array<{ start: number; end: number; speed: number }> = []

  for (let t = visibleStart; t < visibleEnd; t += sampleInterval) {
    // Skip hidden ranges
    const isHidden = hiddenRanges.some(
      (r) => t >= (r.start as number) && t < (r.end as number),
    )
    if (isHidden) continue

    const activity = classifyTimepoint(toMonotonic(t), actions, resources)
    let speed = speedForActivity(activity, config)
    speed = Math.min(speed, c.maxSpeed)

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
  }
}
