import { describe, it, expect } from 'vitest'
import { processSpeed } from '../../../src/speed/speed-processor'
import { toMonotonic } from '../../../src/types/trace'
import type { FilteredTrace, TraceAction, TraceResource, ScreencastFrame, MonotonicMs } from '../../../src/types/trace'
import type { SpeedConfig, SpeedRule, SpeedRuleContext } from '../../../src/types/speed'

function makeAction(
  start: number,
  end: number,
  method = 'click',
  pageId?: string,
): TraceAction {
  return {
    callId: `call-${start}`,
    title: `locator.${method}`,
    class: 'Locator',
    method,
    params: {},
    startTime: toMonotonic(start),
    endTime: toMonotonic(end),
    pageId,
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

function makeFrame(timestamp: number, pageId: string): ScreencastFrame {
  return {
    sha1: `frame-${timestamp}`,
    timestamp: toMonotonic(timestamp),
    pageId,
    width: 1280,
    height: 720,
  }
}

function makeTrace(
  actions: TraceAction[],
  resources: TraceResource[],
  start: number,
  end: number,
  frames: ScreencastFrame[] = [],
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
    frames,
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

describe('processSpeed — custom rules', () => {
  it('applies a custom rule that matches based on activityType', () => {
    // All idle trace, but a custom rule overrides the idle speed
    const trace = makeTrace([], [], 0, 2000)
    const rule: SpeedRule = {
      name: 'slow-idle',
      match: (ctx) => ctx.activityType === 'idle',
      speed: 2.0,
    }
    const config: SpeedConfig = {
      duringIdle: 8.0,
      rules: [rule],
    }

    const result = processSpeed(trace, config)

    // The custom rule should override the duringIdle speed
    for (const seg of result.speedSegments) {
      expect(seg.speed).toBe(2.0)
    }
  })

  it('first matching rule wins when multiple rules are provided', () => {
    const trace = makeTrace([], [], 0, 2000)
    const rules: SpeedRule[] = [
      { name: 'first', match: () => true, speed: 3.0 },
      { name: 'second', match: () => true, speed: 5.0 },
    ]
    const config: SpeedConfig = { rules }

    const result = processSpeed(trace, config)

    // First rule (speed 3.0) should win over second (speed 5.0)
    for (const seg of result.speedSegments) {
      expect(seg.speed).toBe(3.0)
    }
  })

  it('falls back to built-in classification when no rule matches', () => {
    const trace = makeTrace([], [], 0, 2000)
    const rule: SpeedRule = {
      name: 'never-matches',
      match: () => false,
      speed: 10.0,
    }
    const config: SpeedConfig = {
      duringIdle: 4.0,
      rules: [rule],
    }

    const result = processSpeed(trace, config)

    // Should use duringIdle (4.0) since rule never matches
    for (const seg of result.speedSegments) {
      expect(seg.speed).toBe(4.0)
    }
  })

  it('provides timeSinceLastAction in rule context', () => {
    // Action at 0–500, then idle 500–5000
    const actions = [makeAction(0, 500, 'click')]
    const trace = makeTrace(actions, [], 0, 5000)

    const contexts: SpeedRuleContext[] = []
    const rule: SpeedRule = {
      name: 'capture-context',
      match: (ctx) => {
        contexts.push({ ...ctx })
        return false // never match — just capture
      },
      speed: 1.0,
    }

    processSpeed(trace, { rules: [rule], minSegmentDuration: 100 })

    // Find a context sampled well after the action ends (e.g., t=2000)
    const laterCtx = contexts.find(
      (c) => (c.time as number) >= 2000 && (c.time as number) <= 2200,
    )
    expect(laterCtx).toBeDefined()
    // timeSinceLastAction should be roughly t - 500 (the action end time)
    expect(laterCtx!.timeSinceLastAction).toBeGreaterThanOrEqual(1400)
    expect(laterCtx!.timeSinceLastAction).toBeLessThanOrEqual(1800)
  })

  it('provides timeUntilNextAction in rule context', () => {
    // Idle 0–3000, then action at 3000–3500
    const actions = [makeAction(3000, 3500, 'click')]
    const trace = makeTrace(actions, [], 0, 4000)

    const contexts: SpeedRuleContext[] = []
    const rule: SpeedRule = {
      name: 'capture-context',
      match: (ctx) => {
        contexts.push({ ...ctx })
        return false
      },
      speed: 1.0,
    }

    processSpeed(trace, { rules: [rule], minSegmentDuration: 100 })

    // Find a context at around t=1000 (2000ms before next action at 3000)
    const earlyCtx = contexts.find(
      (c) => (c.time as number) >= 900 && (c.time as number) <= 1100,
    )
    expect(earlyCtx).toBeDefined()
    // timeUntilNextAction should be roughly 3000 - t
    expect(earlyCtx!.timeUntilNextAction).toBeGreaterThanOrEqual(1900)
    expect(earlyCtx!.timeUntilNextAction).toBeLessThanOrEqual(2200)
  })

  it('timeSinceLastAction is Infinity when no prior actions exist', () => {
    // Action at 3000–3500, sample at t=1000 (before any action)
    const actions = [makeAction(3000, 3500, 'click')]
    const trace = makeTrace(actions, [], 0, 4000)

    const contexts: SpeedRuleContext[] = []
    const rule: SpeedRule = {
      name: 'capture-context',
      match: (ctx) => {
        contexts.push({ ...ctx })
        return false
      },
      speed: 1.0,
    }

    processSpeed(trace, { rules: [rule], minSegmentDuration: 100 })

    // At t=0, no action has ended yet
    const firstCtx = contexts.find((c) => (c.time as number) === 0)
    expect(firstCtx).toBeDefined()
    expect(firstCtx!.timeSinceLastAction).toBe(Infinity)
  })

  it('timeUntilNextAction is Infinity when no future actions exist', () => {
    // Action at 0–500, then idle. At t=2000, no future actions.
    const actions = [makeAction(0, 500, 'click')]
    const trace = makeTrace(actions, [], 0, 3000)

    const contexts: SpeedRuleContext[] = []
    const rule: SpeedRule = {
      name: 'capture-context',
      match: (ctx) => {
        contexts.push({ ...ctx })
        return false
      },
      speed: 1.0,
    }

    processSpeed(trace, { rules: [rule], minSegmentDuration: 100 })

    // At t=2000, no future action start exists
    const laterCtx = contexts.find(
      (c) => (c.time as number) >= 2000 && (c.time as number) <= 2200,
    )
    expect(laterCtx).toBeDefined()
    expect(laterCtx!.timeUntilNextAction).toBe(Infinity)
  })

  it('custom rule can use timeSinceLastAction to speed up long idle gaps', () => {
    // Action at 0–500, then 9500ms of idle
    const actions = [makeAction(0, 500, 'click')]
    const trace = makeTrace(actions, [], 0, 10000)

    const rule: SpeedRule = {
      name: 'fast-after-2s',
      match: (ctx) => ctx.timeSinceLastAction > 2000,
      speed: 8.0,
    }
    const config: SpeedConfig = {
      duringIdle: 4.0,
      duringUserAction: 1.0,
      rules: [rule],
      minSegmentDuration: 100,
    }

    const result = processSpeed(trace, config)

    // There should be segments at 8.0x speed (custom rule) for long idle gaps
    const fastSegments = result.speedSegments.filter((s) => s.speed === 8.0)
    expect(fastSegments.length).toBeGreaterThan(0)
  })
})

describe('processSpeed — recording page auto-detection', () => {
  it('auto-detects recording pageId from last screencast frame', () => {
    // Two pages: 'setup-page' has early frames, 'recording-page' has later frames
    const frames = [
      makeFrame(0, 'setup-page'),
      makeFrame(100, 'setup-page'),
      makeFrame(200, 'recording-page'),
      makeFrame(1000, 'recording-page'),
      makeFrame(2000, 'recording-page'), // last frame → recording page
    ]

    // Setup-page action should be ignored for user-action classification
    // Recording-page action should be included
    const actions = [
      makeAction(0, 500, 'click', 'setup-page'),
      makeAction(1000, 1500, 'click', 'recording-page'),
    ]

    const trace = makeTrace(actions, [], 0, 3000, frames)

    // Capture the rule contexts to verify filtering
    const contexts: SpeedRuleContext[] = []
    const rule: SpeedRule = {
      name: 'capture',
      match: (ctx) => {
        contexts.push({ ...ctx })
        return false
      },
      speed: 1.0,
    }

    processSpeed(trace, { rules: [rule], minSegmentDuration: 100 })

    // At t=2500 (well after recording-page action at 1000–1500),
    // timeSinceLastAction should reference the recording-page action end (1500),
    // NOT the setup-page action end (500)
    const lateCtx = contexts.find(
      (c) => (c.time as number) >= 2500 && (c.time as number) <= 2600,
    )
    expect(lateCtx).toBeDefined()
    // timeSinceLastAction ~ 2500 - 1500 = 1000
    expect(lateCtx!.timeSinceLastAction).toBeGreaterThanOrEqual(900)
    expect(lateCtx!.timeSinceLastAction).toBeLessThanOrEqual(1200)
  })

  it('respects explicit recordingPageId from config', () => {
    const frames = [
      makeFrame(0, 'page-a'),
      makeFrame(2000, 'page-b'), // last frame → page-b would be auto-detected
    ]

    const actions = [
      makeAction(0, 500, 'click', 'page-a'),
      makeAction(1000, 1500, 'click', 'page-b'),
    ]

    const trace = makeTrace(actions, [], 0, 3000, frames)

    const contexts: SpeedRuleContext[] = []
    const rule: SpeedRule = {
      name: 'capture',
      match: (ctx) => {
        contexts.push({ ...ctx })
        return false
      },
      speed: 1.0,
    }

    // Force recording page to page-a (overriding auto-detection of page-b)
    processSpeed(trace, {
      rules: [rule],
      recordingPageId: 'page-a',
      minSegmentDuration: 100,
    })

    // At t=2500, timeSinceLastAction should reference page-a action (end 500),
    // not page-b action (end 1500)
    const lateCtx = contexts.find(
      (c) => (c.time as number) >= 2500 && (c.time as number) <= 2600,
    )
    expect(lateCtx).toBeDefined()
    // timeSinceLastAction ~ 2500 - 500 = 2000
    expect(lateCtx!.timeSinceLastAction).toBeGreaterThanOrEqual(1900)
    expect(lateCtx!.timeSinceLastAction).toBeLessThanOrEqual(2200)
  })
})

describe('processSpeed — pageId filtering in buildUserActionTimeline', () => {
  it('filters out actions from non-recording pages', () => {
    const frames = [
      makeFrame(0, 'rec-page'),
      makeFrame(5000, 'rec-page'),
    ]

    // Non-recording-page action in the middle should not affect timing
    const actions = [
      makeAction(0, 500, 'click', 'rec-page'),
      makeAction(2000, 2500, 'click', 'other-page'), // should be ignored
    ]

    const trace = makeTrace(actions, [], 0, 5000, frames)

    const contexts: SpeedRuleContext[] = []
    const rule: SpeedRule = {
      name: 'capture',
      match: (ctx) => {
        contexts.push({ ...ctx })
        return false
      },
      speed: 1.0,
    }

    processSpeed(trace, { rules: [rule], minSegmentDuration: 100 })

    // At t=3000, timeSinceLastAction should reference rec-page action (end 500),
    // not other-page action (end 2500)
    const ctx = contexts.find(
      (c) => (c.time as number) >= 3000 && (c.time as number) <= 3200,
    )
    expect(ctx).toBeDefined()
    expect(ctx!.timeSinceLastAction).toBeGreaterThanOrEqual(2400)
    expect(ctx!.timeSinceLastAction).toBeLessThanOrEqual(2800)
  })

  it('includes actions without pageId (they are not filtered out)', () => {
    const frames = [
      makeFrame(0, 'rec-page'),
      makeFrame(5000, 'rec-page'),
    ]

    // Action with no pageId should still be included
    const actions = [
      makeAction(2000, 2500, 'click'), // no pageId
    ]

    const trace = makeTrace(actions, [], 0, 5000, frames)

    const contexts: SpeedRuleContext[] = []
    const rule: SpeedRule = {
      name: 'capture',
      match: (ctx) => {
        contexts.push({ ...ctx })
        return false
      },
      speed: 1.0,
    }

    processSpeed(trace, { rules: [rule], minSegmentDuration: 100 })

    // At t=3000, timeSinceLastAction should reference the action at 2000–2500
    // (it has no pageId, so it is NOT filtered out)
    const ctx = contexts.find(
      (c) => (c.time as number) >= 3000 && (c.time as number) <= 3200,
    )
    expect(ctx).toBeDefined()
    expect(ctx!.timeSinceLastAction).toBeGreaterThanOrEqual(400)
    expect(ctx!.timeSinceLastAction).toBeLessThanOrEqual(800)
  })
})

describe('processSpeed — explicit segments mode', () => {
  it('uses pre-built segments and bypasses classification', () => {
    const actions = [makeAction(1000, 2000, 'click', 'rec-page')]
    const frames = [
      makeFrame(1000, 'rec-page'),
      makeFrame(5000, 'rec-page'),
    ]
    const trace = makeTrace(actions, [], 0, 6000, frames)

    const config: SpeedConfig = {
      duringIdle: 4.0, // should be ignored
      segments: [
        { startMs: 0, endMs: 1000, speed: 1.0 },
        { startMs: 1000, endMs: 2000, speed: 2.0 },
        { startMs: 2000, endMs: 4000, speed: 4.0 },
      ],
    }

    const result = processSpeed(trace, config)

    // Should have exactly 3 segments (matching the explicit segments)
    expect(result.speedSegments).toHaveLength(3)
    expect(result.speedSegments[0]!.speed).toBe(1.0)
    expect(result.speedSegments[1]!.speed).toBe(2.0)
    expect(result.speedSegments[2]!.speed).toBe(4.0)
  })

  it('computes correct output duration for explicit segments', () => {
    const frames = [
      makeFrame(1000, 'rec-page'),
      makeFrame(5000, 'rec-page'),
    ]
    const actions = [makeAction(1000, 1500, 'click', 'rec-page')]
    const trace = makeTrace(actions, [], 0, 6000, frames)

    const config: SpeedConfig = {
      segments: [
        { startMs: 0, endMs: 2000, speed: 1.0 }, // 2000ms at 1x = 2000ms
        { startMs: 2000, endMs: 4000, speed: 2.0 }, // 2000ms at 2x = 1000ms
      ],
    }

    const result = processSpeed(trace, config)

    // Total output: 2000 + 1000 = 3000ms
    expect(result.outputDuration).toBeCloseTo(3000, -1)
  })

  it('offsets explicit segments by baseline (first recording action startTime)', () => {
    const frames = [
      makeFrame(5000, 'rec-page'),
      makeFrame(10000, 'rec-page'),
    ]
    const actions = [makeAction(5000, 6000, 'click', 'rec-page')]
    const trace = makeTrace(actions, [], 0, 11000, frames)

    const config: SpeedConfig = {
      segments: [
        { startMs: 0, endMs: 1000, speed: 1.0 },
        { startMs: 1000, endMs: 3000, speed: 2.0 },
      ],
    }

    const result = processSpeed(trace, config)

    // Baseline = first recording action startTime = 5000
    // Segment 0: originalStart = 0 + 5000 = 5000, originalEnd = 1000 + 5000 = 6000
    // Segment 1: originalStart = 6000, originalEnd = 8000
    expect(result.speedSegments[0]!.originalStart).toBe(toMonotonic(5000))
    expect(result.speedSegments[0]!.originalEnd).toBe(toMonotonic(6000))
    expect(result.speedSegments[1]!.originalStart).toBe(toMonotonic(6000))
    expect(result.speedSegments[1]!.originalEnd).toBe(toMonotonic(8000))
  })

  it('carries postFastForwardSettleMs through in explicit segments mode', () => {
    const frames = [
      makeFrame(1000, 'rec-page'),
      makeFrame(5000, 'rec-page'),
    ]
    const actions = [makeAction(1000, 1500, 'click', 'rec-page')]
    const trace = makeTrace(actions, [], 0, 6000, frames)

    const config: SpeedConfig = {
      segments: [{ startMs: 0, endMs: 2000, speed: 1.0 }],
      postFastForwardSettleMs: 500,
    }

    const result = processSpeed(trace, config)

    expect(result.postFastForwardSettleMs).toBe(500)
  })

  it('ignores explicit segments when array is empty', () => {
    const trace = makeTrace([], [], 0, 2000)
    const config: SpeedConfig = {
      duringIdle: 4.0,
      segments: [], // empty → should use normal classification
    }

    const result = processSpeed(trace, config)

    // Should fall through to normal idle classification at 4.0x
    expect(result.speedSegments.length).toBeGreaterThan(0)
    for (const seg of result.speedSegments) {
      expect(seg.speed).toBe(4.0)
    }
  })
})

describe('processSpeed — postFastForwardSettleMs passthrough', () => {
  it('carries postFastForwardSettleMs in normal classification mode', () => {
    const trace = makeTrace([], [], 0, 2000)
    const config: SpeedConfig = {
      duringIdle: 4.0,
      postFastForwardSettleMs: 300,
    }

    const result = processSpeed(trace, config)

    expect(result.postFastForwardSettleMs).toBe(300)
  })

  it('postFastForwardSettleMs is undefined when not set', () => {
    const trace = makeTrace([], [], 0, 2000)
    const result = processSpeed(trace, {})

    expect(result.postFastForwardSettleMs).toBeUndefined()
  })
})
