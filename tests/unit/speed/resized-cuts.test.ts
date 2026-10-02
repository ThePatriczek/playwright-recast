import { describe, it, expect } from 'vitest'
import { processSpeed } from '../../../src/speed/speed-processor'
import { toMonotonic } from '../../../src/types/trace'
import type { FilteredTrace } from '../../../src/types/trace'

const PAGE = 'page@aa'
const trace = (resized: Array<[number, number, string?]>): FilteredTrace => ({
  metadata: { browserName: 'chromium', platform: 'linux', viewport: { width: 1280, height: 720 }, startTime: toMonotonic(0), endTime: toMonotonic(4000), wallTime: 0 },
  frames: [{ sha1: 'f', timestamp: toMonotonic(0), pageId: PAGE, width: 1280, height: 720 }],
  actions: [], resources: [], events: [], cursorPositions: [],
  resizedFrames: resized.map(([start, end, pageId]) => ({ pageId: pageId ?? PAGE, start: toMonotonic(start), end: toMonotonic(end) })),
  frameReader: { readFrame: async () => Buffer.alloc(0), dispose: () => {} },
  originalActions: [], hiddenRanges: [],
})
const outputOf = (t: ReturnType<typeof processSpeed>, a: number, b: number) =>
  t.timeRemap(toMonotonic(b)) - t.timeRemap(toMonotonic(a))

describe('processSpeed: resized frames', () => {
  it('cuts them exactly, also off the sample grid', () => {
    const t = processSpeed(trace([[1503, 1857]]), { duringIdle: 2 })
    expect(outputOf(t, 1503, 1857)).toBe(0)
    expect(t.outputDuration).toBeCloseTo((4000 - 354) / 2, 0)
  })

  it('keeps them with keepResizedFrames', () => {
    expect(processSpeed(trace([[1503, 1857]]), { duringIdle: 2, keepResizedFrames: true }).outputDuration).toBeCloseTo(2000, 0)
  })

  it('cuts them out of explicit segments', () => {
    const t = processSpeed(trace([[1503, 1857]]), { segments: [{ startMs: 0, endMs: 4000, speed: 2 }] })
    expect(outputOf(t, 1503, 1857)).toBe(0)
    expect(t.outputDuration).toBeCloseTo((4000 - 354) / 2, 5)
  })

  it("cuts only the recording page's", () => {
    expect(processSpeed(trace([[1503, 1857, 'page@other']]), { duringIdle: 2 }).outputDuration).toBeCloseTo(2000, 0)
  })

  it("cuts the video page's, whatever recordingPageId scopes actions to", () => {
    expect(processSpeed(trace([[1503, 1857]]), { duringIdle: 2, recordingPageId: 'page@other' }).outputDuration).toBeCloseTo((4000 - 354) / 2, 0)
    expect(processSpeed(trace([[1503, 1857, 'page@other']]), { duringIdle: 2, recordingPageId: 'page@other' }).outputDuration).toBeCloseTo(2000, 0)
  })
})
