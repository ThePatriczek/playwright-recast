import { describe, it, expect } from 'vitest'
import { mcpTimeBases, wallToTrace } from '../time-bases.js'
import { toMonotonic } from '../../types/trace.js'
import type { ScreencastFrame, TraceAction } from '../../types/trace.js'

const frame = (pageId: string, t: number): ScreencastFrame => ({ sha1: 'f', timestamp: toMonotonic(t), pageId, width: 1280, height: 720 })
const action = (pageId: string | undefined, t: number): TraceAction => ({
  callId: `c${t}`, title: 't', class: 'Frame', method: 'click', params: {},
  startTime: toMonotonic(t), endTime: toMonotonic(t + 10), pageId,
})
// A setup page first, then the recording page from 51 000 on (a long-lived process: large monotonic times)
const parsed = {
  frames: [frame('setup', 50_200), frame('rec', 51_000), frame('rec', 60_000)],
  actions: [action('setup', 50_100), action('rec', 51_500), action('rec', 55_000)],
  metadata: { browserName: 'chromium', platform: 'linux', viewport: { width: 1280, height: 720 }, startTime: toMonotonic(50_000), endTime: toMonotonic(61_000), wallTime: 0 },
}

describe('mcpTimeBases', () => {
  it('maps trace times onto the video clock and the SRT clock', () => {
    const time = mcpTimeBases(parsed)
    expect(time.toVideo(55_000)).toBe(4000) // from the recording page's first frame
    expect(time.toSrt(55_000)).toBe(3500) // from the recording page's first action
    expect(time.videoEndMs).toBe(10_000)
  })

  it('starts the SRT clock at the first frame when no action has the page id', () => {
    const time = mcpTimeBases({ ...parsed, actions: [action(undefined, 51_500)] })
    expect(time.toSrt(55_000)).toBe(4000)
  })
})

describe('wallToTrace', () => {
  it('maps recorded wall-clock times through the trace\'s wall/monotonic pair', () => {
    // Tracing started at wall 1_700_000_000_000 = monotonic 50_000; the first
    // recorded action came 4 s later (page load, think time)
    const toTrace = wallToTrace({ ...parsed.metadata, wallTime: 1_700_000_000_000, wallMonotonicTime: 50_000 }, 1_700_000_004_000)
    expect(toTrace(1_700_000_004_000)).toBe(54_000)
    expect(toTrace(1_700_000_005_000)).toBe(55_000)
  })

  it('without the pair, takes the first recorded action as the trace start', () => {
    const toTrace = wallToTrace({ ...parsed.metadata, wallTime: 0 }, 1_700_000_004_000)
    expect(toTrace(1_700_000_005_000)).toBe(51_000)
  })

  it('falls back when the pair maps the recording outside the trace (a mocked page clock)', () => {
    const toTrace = wallToTrace({ ...parsed.metadata, wallTime: 1_700_000_000_000, wallMonotonicTime: 50_000 }, 1_600_000_000_000)
    expect(toTrace(1_600_000_001_000)).toBe(51_000)
  })
})
