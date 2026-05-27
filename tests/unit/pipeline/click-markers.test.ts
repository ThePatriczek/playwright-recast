import { describe, it, expect } from 'vitest'
import {
  parseClickMarkers,
  parseClickMarkersFromRecordingContext,
  resolveClickMarkers,
  type AutoClick,
  type ClickMarker,
} from '../../../src/pipeline/click-markers'
import { CLICK_TITLE_PREFIX } from '../../../src/helpers'

function auto(callId: string, x: number, y: number, startTime: number, endTime: number): AutoClick {
  return { callId, x, y, startTime, endTime }
}
function marker(x: number, y: number, startTime: number): ClickMarker {
  return { x, y, startTime }
}

describe('parseClickMarkers', () => {
  it('extracts coords + startTime from marker steps and ignores others', () => {
    const actions = [
      { title: `${CLICK_TITLE_PREFIX}${JSON.stringify({ x: 12, y: 34 })}`, startTime: 1000 },
      { title: 'click', startTime: 1100 },
      { title: `${CLICK_TITLE_PREFIX}not-json`, startTime: 1200 },
    ]
    expect(parseClickMarkers(actions)).toEqual([{ x: 12, y: 34, startTime: 1000 }])
  })

  it('can restrict marker parsing to the recording context', () => {
    const actions = [
      { title: `${CLICK_TITLE_PREFIX}${JSON.stringify({ x: 1, y: 2 })}`, startTime: 900 },
      { title: `${CLICK_TITLE_PREFIX}${JSON.stringify({ x: 3, y: 4 })}`, startTime: 1000 },
      { title: `${CLICK_TITLE_PREFIX}${JSON.stringify({ x: 5, y: 6 })}`, startTime: 1100 },
    ]

    expect(parseClickMarkersFromRecordingContext(actions, 1000)).toEqual([
      { x: 3, y: 4, startTime: 1000 },
      { x: 5, y: 6, startTime: 1100 },
    ])
  })
})

describe('resolveClickMarkers', () => {
  it('with no markers, returns every auto-click as unmarked at its endTime', () => {
    const autos = [auto('a', 10, 10, 1000, 1050), auto('b', 20, 20, 2000, 2080)]
    const { resolved, consumedCallIds } = resolveClickMarkers(autos, [])
    expect(consumedCallIds.size).toBe(0)
    expect(resolved).toEqual([
      { x: 10, y: 10, traceTimeMs: 1050, marked: false },
      { x: 20, y: 20, traceTimeMs: 2080, marked: false },
    ])
  })

  it('matches a marker to a same-position auto-click in its window and suppresses it', () => {
    const autos = [auto('a', 100, 200, 5000, 8000)]
    const markers = [marker(100, 200, 4990)]
    const { resolved, consumedCallIds } = resolveClickMarkers(autos, markers)
    expect(consumedCallIds.has('a')).toBe(true)
    expect(resolved).toEqual([{ x: 100, y: 200, traceTimeMs: 4990, marked: true }])
  })

  it('keeps an unmatched marker as a marked click', () => {
    const { resolved, consumedCallIds } = resolveClickMarkers([], [marker(5, 6, 700)])
    expect(consumedCallIds.size).toBe(0)
    expect(resolved).toEqual([{ x: 5, y: 6, traceTimeMs: 700, marked: true }])
  })

  it('does not match when positions differ beyond tolerance', () => {
    const autos = [auto('a', 100, 200, 5000, 5050)]
    const markers = [marker(100, 240, 4990)]
    const { resolved, consumedCallIds } = resolveClickMarkers(autos, markers)
    expect(consumedCallIds.size).toBe(0)
    expect(resolved).toEqual([
      { x: 100, y: 240, traceTimeMs: 4990, marked: true },
      { x: 100, y: 200, traceTimeMs: 5050, marked: false },
    ])
  })

  it('does not match when the marker is outside the time window', () => {
    const autos = [auto('a', 100, 200, 5000, 5050)]
    const markers = [marker(100, 200, 3000)]
    const { consumedCallIds } = resolveClickMarkers(autos, markers)
    expect(consumedCallIds.size).toBe(0)
  })

  it('matches each auto-click at most once; the nearest eligible marker wins', () => {
    const autos = [auto('a', 100, 200, 5000, 5050)]
    const markers = [marker(100, 200, 4900), marker(100, 200, 4995)]
    const { resolved, consumedCallIds } = resolveClickMarkers(autos, markers)
    expect(consumedCallIds.has('a')).toBe(true)
    expect(resolved).toEqual([
      { x: 100, y: 200, traceTimeMs: 4995, marked: true },
    ])
  })

  it('sorts the resolved list by traceTimeMs', () => {
    const autos = [auto('a', 10, 10, 3000, 3050)]
    const markers = [marker(99, 99, 1000)]
    const { resolved } = resolveClickMarkers(autos, markers)
    expect(resolved.map((r) => r.traceTimeMs)).toEqual([1000, 3050])
  })
})
