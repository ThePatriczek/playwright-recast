import { describe, it, expect } from 'vitest'
import { buildSamplePoints } from '../../../src/speed/sample-points'
import { processSpeed } from '../../../src/speed/speed-processor'
import { toMonotonic } from '../../../src/types/trace'
import type { FilteredTrace, TraceAction, TraceResource } from '../../../src/types/trace'
import type { SpeedConfig } from '../../../src/types/speed'
import { NARRATE_TITLE_PREFIX } from '../../../src/helpers'

function makeAction(
  start: number,
  end: number,
  method = 'click',
  title = `locator.${method}`,
): TraceAction {
  return {
    callId: `call-${start}`,
    title,
    class: 'Locator',
    method,
    params: {},
    startTime: toMonotonic(start),
    endTime: toMonotonic(end),
  }
}

function makeTrace(
  actions: TraceAction[],
  resources: TraceResource[],
  start: number,
  end: number,
  hiddenRanges: Array<{ start: number; end: number }> = [],
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
    hiddenRanges: hiddenRanges.map((r) => ({
      start: toMonotonic(r.start),
      end: toMonotonic(r.end),
    })),
  }
}

describe('buildSamplePoints property: interval never spans a boundary', () => {
  it('an interval never spans a boundary when the flag is on', () => {
    // The classifier walks points pairwise; no interval may contain a
    // boundary in its interior, or the scene on one side gets the other
    // side's speed.
    const boundaries = [237, 456, 460]
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 600, sampleInterval: 100,
      exactBoundaries: true, boundaryTimes: boundaries,
    })
    for (let i = 0; i < points.length - 1; i++) {
      const [lo, hi] = [points[i]!, points[i + 1]!]
      for (const b of boundaries) {
        expect(b > lo && b < hi).toBe(false)
      }
    }
  })
})

describe('processSpeed with exactBoundaries: end-to-end (#22)', () => {
  // 0–230: idle. 230–249: a real user action (off-grid). 250–500: idle.
  // A narration-boundary marker action spans exactly 230–250 — its title
  // marks it as a boundary but its method ('evaluate') is not a
  // USER_ACTION_METHOD, so it never itself drives classification; it only
  // contributes 230 and 250 to boundaryTimes. The 19ms user-action window
  // is short enough that the fixed 100ms grid (0, 100, 200, 300, 400, 500)
  // never samples inside it — that's the defect from #22.
  //
  // minSegmentDuration is set to 10ms (default is 500ms). At the default,
  // the merge step (speed-processor.ts, "Apply minSegmentDuration") would
  // fold the ~20ms user-action segment back into its idle neighbour even
  // with exactBoundaries on, which would make this test pass or fail for a
  // reason unrelated to sampling. Lowering it isolates what this test
  // actually checks: that sampling — not merging — preserves the scene.
  function makeShortSceneTrace() {
    const narrationMarker = makeAction(230, 250, 'evaluate', `${NARRATE_TITLE_PREFIX}short scene`)
    const userAction = makeAction(230, 249, 'click', 'locator.click')
    return makeTrace([narrationMarker, userAction], [], 0, 500)
  }

  it('flag on: the short scene keeps its own segment instead of being swallowed by the grid', () => {
    const trace = makeShortSceneTrace()
    const config: SpeedConfig = {
      duringIdle: 4.0,
      duringUserAction: 1.0,
      minSegmentDuration: 10,
      exactBoundaries: true,
    }

    const result = processSpeed(trace, config)

    const boundaryTimes = result.speedSegments.map((s) => [s.originalStart as number, s.originalEnd as number])
    const scene = boundaryTimes.find(([s]) => s === 230)
    expect(scene).toEqual([230, 250])
    const sceneSpeed = result.speedSegments.find((s) => (s.originalStart as number) === 230)!.speed
    expect(sceneSpeed).toBe(1.0)
  })

  it('flag off (default): the bug persists — the short scene is swallowed by the grid', () => {
    // Same fixture, same minSegmentDuration, only exactBoundaries differs.
    // This is the pairing that actually proves the fix: without it, the
    // scene never surfaces as its own segment.
    const trace = makeShortSceneTrace()
    const config: SpeedConfig = {
      duringIdle: 4.0,
      duringUserAction: 1.0,
      minSegmentDuration: 10,
    }

    const result = processSpeed(trace, config)

    const starts = result.speedSegments.map((s) => s.originalStart as number)
    const ends = result.speedSegments.map((s) => s.originalEnd as number)
    expect(starts).not.toContain(230)
    expect(ends).not.toContain(230)
    expect(starts).not.toContain(250)
    // None of the fixed 100ms grid samples (0, 100, 200, 300, 400) fall
    // inside the 230–249 action window, so the whole trace reads as idle.
    for (const seg of result.speedSegments) {
      expect(seg.speed).toBe(4.0)
    }
  })

  it('flag on: segments align to an off-grid hidden range instead of the surrounding grid cell', () => {
    // Hidden range 150–170 doesn't land on the 100ms grid either. With the
    // flag on, its start/end join the sample points, so the segment before
    // it ends exactly at 150 and the segment after it starts exactly at 170.
    const trace = makeTrace([], [], 0, 300, [{ start: 150, end: 170 }])
    const config: SpeedConfig = {
      duringIdle: 4.0,
      exactBoundaries: true,
    }

    const result = processSpeed(trace, config)

    const ranges = result.speedSegments.map((s) => [s.originalStart as number, s.originalEnd as number])
    expect(ranges).toEqual([[0, 150], [170, 300]])
  })
})
