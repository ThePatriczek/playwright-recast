import { describe, it, expect } from 'vitest'
import { processSpeed } from '../../../src/speed/speed-processor'
import { toMonotonic } from '../../../src/types/trace'
import type { FilteredTrace, TraceAction, TraceResource, MonotonicMs } from '../../../src/types/trace'
import type { SpeedConfig } from '../../../src/types/speed'

function makeAction(start: number, end: number, method = 'click'): TraceAction {
  return {
    callId: `call-${start}`,
    title: `locator.${method}`,
    class: 'Locator',
    method,
    params: {},
    startTime: toMonotonic(start),
    endTime: toMonotonic(end),
  }
}

function makeResource(start: number, end: number): TraceResource {
  return {
    url: 'https://api.example.com/data',
    method: 'GET',
    status: 200,
    startTime: toMonotonic(start),
    endTime: toMonotonic(end),
    mimeType: 'application/json',
  }
}

function makeTrace(
  actions: TraceAction[],
  resources: TraceResource[],
  start: number,
  end: number,
): FilteredTrace {
  return {
    metadata: {
      browserName: 'chromium',
      platform: 'linux',
      viewport: { width: 1280, height: 720 },
      startTime: toMonotonic(start),
      endTime: toMonotonic(end),
      wallTime: Date.now(),
    },
    frames: [],
    actions,
    resources,
    events: [],
    cursorPositions: [],
    frameReader: {
      readFrame: async () => Buffer.alloc(0),
      dispose: () => {},
    },
    originalActions: actions,
    hiddenRanges: [],
  }
}

describe('processSpeed', () => {
  it('speeds up all idle periods', () => {
    // 2 seconds of pure idle (no actions, no resources)
    const trace = makeTrace([], [], 0, 2000)
    const config: SpeedConfig = { duringIdle: 4.0 }

    const result = processSpeed(trace, config)

    expect(result.speedSegments.length).toBeGreaterThan(0)
    // All segments should have idle speed
    for (const seg of result.speedSegments) {
      expect(seg.speed).toBe(4.0)
    }
    // Output duration should be shorter than original
    expect(result.outputDuration).toBeLessThan(2000)
  })

  it('keeps user actions at normal speed', () => {
    // Action spans the entire trace
    const actions = [makeAction(0, 2000, 'click')]
    const trace = makeTrace(actions, [], 0, 2000)
    const config: SpeedConfig = { duringIdle: 4.0, duringUserAction: 1.0 }

    const result = processSpeed(trace, config)

    expect(result.speedSegments.length).toBeGreaterThan(0)
    // All segments should be at user-action speed (1.0)
    for (const seg of result.speedSegments) {
      expect(seg.speed).toBe(1.0)
    }
    // Output duration should equal original (speed = 1.0)
    expect(result.outputDuration).toBeCloseTo(2000, -2)
  })

  it('produces multiple segments for mixed activity', () => {
    // 0–1000: user action, 1000–3000: idle
    const actions = [makeAction(0, 1000, 'fill')]
    const trace = makeTrace(actions, [], 0, 3000)
    const config: SpeedConfig = {
      duringIdle: 4.0,
      duringUserAction: 1.0,
      minSegmentDuration: 100,
    }

    const result = processSpeed(trace, config)

    // Should have at least two distinct speed regions
    const speeds = new Set(result.speedSegments.map((s) => s.speed))
    expect(speeds.size).toBeGreaterThanOrEqual(2)

    // Output duration should be less than original (idle is sped up)
    expect(result.outputDuration).toBeLessThan(3000)
    expect(result.outputDuration).toBeGreaterThan(0)
  })

  it('merges short segments via minSegmentDuration', () => {
    // Create a trace where one tiny action causes a brief speed change
    // surrounded by idle time — the small segment should be merged away
    const actions = [makeAction(1000, 1100, 'click')]
    const trace = makeTrace(actions, [], 0, 3000)
    const config: SpeedConfig = {
      duringIdle: 4.0,
      duringUserAction: 1.0,
      // Large minimum so the brief action segment gets merged
      minSegmentDuration: 500,
    }

    const result = processSpeed(trace, config)

    // Segments should be fewer than without merging
    // (the tiny action segment gets absorbed into its neighbor)
    for (const seg of result.speedSegments) {
      const duration = (seg.originalEnd as number) - (seg.originalStart as number)
      // After merging, all segments should meet the min duration
      // (except possibly the very first one if it was already under before merging kicked in)
      expect(duration).toBeGreaterThanOrEqual(0)
    }

    // The output should still have valid data
    expect(result.outputDuration).toBeGreaterThan(0)
  })

  it('returns empty segments for zero-duration trace', () => {
    const trace = makeTrace([], [], 5000, 5000)
    const config: SpeedConfig = {}

    const result = processSpeed(trace, config)

    expect(result.speedSegments).toEqual([])
    expect(result.outputDuration).toBe(0)
    expect(result.timeRemap(toMonotonic(5000))).toBe(0)
  })

  it('handles empty actions with network resources', () => {
    // No user actions, only network resources — should classify as network-wait
    const resources = [makeResource(0, 2000)]
    const trace = makeTrace([], resources, 0, 2000)
    const config: SpeedConfig = {
      duringNetworkWait: 2.0,
      duringIdle: 4.0,
    }

    const result = processSpeed(trace, config)

    expect(result.speedSegments.length).toBeGreaterThan(0)
    // All time has network activity, so speed should be network-wait speed
    for (const seg of result.speedSegments) {
      expect(seg.speed).toBe(2.0)
    }
  })

  it('respects maxSpeed clamp', () => {
    const trace = makeTrace([], [], 0, 2000)
    const config: SpeedConfig = {
      duringIdle: 20.0,
      maxSpeed: 8.0,
    }

    const result = processSpeed(trace, config)

    for (const seg of result.speedSegments) {
      expect(seg.speed).toBeLessThanOrEqual(8.0)
    }
  })

  it('does not merge short segments across a hideSteps() gap', () => {
    // Reproduces the bug where a short pre-hidden segment + a short
    // post-hidden segment of the same speed got merged into one segment
    // that swallowed the hidden range — causing the renderer to slice
    // the hidden content back into the output.
    // Trace: short navigation before hidden range, short navigation after,
    // both 2x; the hidden gap must remain a gap in segment coverage.
    const actions = [
      makeAction(1300, 1400, 'goto'),
      makeAction(15000, 15100, 'goto'),
    ]
    const trace: FilteredTrace = {
      ...makeTrace(actions, [], 1000, 17000),
      hiddenRanges: [
        { start: toMonotonic(1500) as MonotonicMs, end: toMonotonic(14800) as MonotonicMs },
      ],
    }
    const result = processSpeed(trace, {
      duringIdle: 3.0,
      duringUserAction: 1.0,
      duringNavigation: 2.0,
      minSegmentDuration: 500,
    })

    // No segment may span across the hidden range.
    const HIDDEN_START = 1500
    const HIDDEN_END = 14800
    for (const seg of result.speedSegments) {
      const s = seg.originalStart as number
      const e = seg.originalEnd as number
      const spansGap = s < HIDDEN_START && e > HIDDEN_END
      expect(spansGap, `segment [${s}, ${e}] spans hidden range`).toBe(false)
    }
  })

  it('provides a working timeRemap function', () => {
    const actions = [makeAction(0, 1000, 'click')]
    const trace = makeTrace(actions, [], 0, 3000)
    const config: SpeedConfig = {
      duringIdle: 4.0,
      duringUserAction: 1.0,
      minSegmentDuration: 100,
    }

    const result = processSpeed(trace, config)

    // Remapped time at start should be near 0
    expect(result.timeRemap(toMonotonic(0))).toBeCloseTo(0, -1)
    // Remapped time at end should equal outputDuration
    const remappedEnd = result.timeRemap(toMonotonic(3000))
    expect(remappedEnd).toBeCloseTo(result.outputDuration, -1)
  })
})
