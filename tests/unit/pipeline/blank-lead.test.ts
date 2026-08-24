import { describe, it, expect, vi } from 'vitest'
import {
  resolveBlankLeadInMs,
  shiftSubtitlesForBlankLead,
  shiftOverlayTimesForBlankLead,
} from '../../../src/pipeline/blank-lead'
import { toMonotonic } from '../../../src/types/trace'
import type { SpeedSegment } from '../../../src/types/speed'
import type { SubtitleEntry } from '../../../src/types/subtitle'

const seg = (speed: number): SpeedSegment => ({
  originalStart: toMonotonic(0),
  originalEnd: toMonotonic(1000),
  speed,
  outputStart: 0,
  outputEnd: 0,
})

const sub = (startMs: number, endMs: number): SubtitleEntry => ({
  index: 1,
  startMs,
  endMs,
  text: 'x',
})

describe('resolveBlankLeadInMs', () => {
  it('converts detected seconds to milliseconds when speed is not the authority', () => {
    expect(resolveBlankLeadInMs(undefined, () => 3)).toBe(3000)
    expect(resolveBlankLeadInMs([], () => 1.5)).toBe(1500)
    expect(resolveBlankLeadInMs([seg(1.0)], () => 0.4)).toBe(400)
  })

  it('returns zero without detecting when speed is the authority', () => {
    // Regression (#20): the detected value is in source-video time, but the
    // timestamps it was subtracted from are already in speed-mapped output
    // time — a unit error that shifted every cue by the full blank duration.
    const detect = vi.fn(() => 3)

    expect(resolveBlankLeadInMs([seg(1.0), seg(4.0)], detect)).toBe(0)
    expect(detect).not.toHaveBeenCalled()
  })

  it('detects exactly once per call in the non-speed path', () => {
    const detect = vi.fn(() => 2)
    resolveBlankLeadInMs([seg(1.0)], detect)
    expect(detect).toHaveBeenCalledTimes(1)
  })
})

describe('shiftSubtitlesForBlankLead', () => {
  it('shifts start and end times back by the offset', () => {
    const subs = [sub(5000, 8000), sub(9000, 11000)]
    shiftSubtitlesForBlankLead(subs, 3000)
    expect(subs.map((s) => [s.startMs, s.endMs])).toEqual([[2000, 5000], [6000, 8000]])
  })

  it('clamps to zero instead of going negative', () => {
    const subs = [sub(1000, 2000)]
    shiftSubtitlesForBlankLead(subs, 3000)
    expect(subs[0]!.startMs).toBe(0)
    expect(subs[0]!.endMs).toBe(0)
  })

  it('shifts zoom windows when present', () => {
    const s = sub(5000, 8000)
    s.zoom = { level: 2, startMs: 5200, endMs: 7800 }
    shiftSubtitlesForBlankLead([s], 3000)
    expect(s.zoom.startMs).toBe(2200)
    expect(s.zoom.endMs).toBe(4800)
  })

  it('leaves a zoom without explicit times alone', () => {
    const s = sub(5000, 8000)
    s.zoom = { level: 2 }
    shiftSubtitlesForBlankLead([s], 3000)
    expect(s.zoom.startMs).toBeUndefined()
    expect(s.zoom.endMs).toBeUndefined()
  })

  it('is a no-op for a zero offset', () => {
    const subs = [sub(5000, 8000)]
    shiftSubtitlesForBlankLead(subs, 0)
    expect(subs[0]!.startMs).toBe(5000)
  })
})

describe('shiftOverlayTimesForBlankLead', () => {
  it('shifts and clamps videoTimeMs', () => {
    const events = [{ videoTimeMs: 4000 }, { videoTimeMs: 1000 }]
    shiftOverlayTimesForBlankLead(events, 3000)
    expect(events.map((e) => e.videoTimeMs)).toEqual([1000, 0])
  })

  it('rounds to whole milliseconds', () => {
    const events = [{ videoTimeMs: 4000.6 }]
    shiftOverlayTimesForBlankLead(events, 3000)
    expect(events[0]!.videoTimeMs).toBe(1001)
  })

  it('is a no-op for a zero offset', () => {
    const events = [{ videoTimeMs: 4000 }]
    shiftOverlayTimesForBlankLead(events, 0)
    expect(events[0]!.videoTimeMs).toBe(4000)
  })
})

describe('blank-lead compensation is skipped only under speed authority', () => {
  it('leaves speed-mapped subtitles untouched end to end', () => {
    // The full pipeline path: subtitles already remapped by timeRemap(),
    // a 3s blank prefix detected in the source. Under speed authority the
    // cue must keep its remapped time (7025ms), not slide to 4025ms.
    const subs = [sub(7025, 9500)]
    const offset = resolveBlankLeadInMs([seg(1.0), seg(4.0)], () => 3)
    shiftSubtitlesForBlankLead(subs, offset)

    expect(subs[0]!.startMs).toBe(7025)
  })

  it('still compensates when there is no speed map (regression guard)', () => {
    // Pipelines without speedUp() must keep today's behavior exactly.
    const subs = [sub(7025, 9500)]
    const offset = resolveBlankLeadInMs(undefined, () => 3)
    shiftSubtitlesForBlankLead(subs, offset)

    expect(subs[0]!.startMs).toBe(4025)
  })
})
