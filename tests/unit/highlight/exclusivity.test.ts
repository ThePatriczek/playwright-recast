import { describe, it, expect } from 'vitest'
import type { HighlightEvent } from '../../../src/types/text-highlight'
import {
  makeHighlightsExclusive,
  shiftHighlightsForFreezes,
} from '../../../src/text-highlight/exclusivity'

function makeEvent(overrides: Partial<HighlightEvent>): HighlightEvent {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    videoTimeMs: 0,
    endTimeMs: 2000,
    color: '#FFEB3B',
    opacity: 0.35,
    swipeDuration: 300,
    fadeOut: 0,
    ...overrides,
  }
}

describe('makeHighlightsExclusive()', () => {
  it('cuts a highlight short when the next one starts before it would end', () => {
    const [first, second] = makeHighlightsExclusive([
      makeEvent({ videoTimeMs: 0, endTimeMs: 4500 }),
      makeEvent({ videoTimeMs: 1500, endTimeMs: 6000 }),
    ])

    expect(first!.endTimeMs).toBe(1500)
    expect(second!.endTimeMs).toBe(6000)
  })

  it('leaves highlights that do not overlap untouched', () => {
    const input = [
      makeEvent({ videoTimeMs: 0, endTimeMs: 1000, fadeOut: 200 }),
      makeEvent({ videoTimeMs: 4000, endTimeMs: 6000, fadeOut: 200 }),
    ]

    expect(makeHighlightsExclusive(input)).toEqual(input)
  })

  it('fits fadeOut to a short window even without a neighbour', () => {
    // The pipeline clamps a highlight to its subtitle's end, so it can arrive
    // shorter than its own fadeOut; the renderer needs end - start - fadeOut > 0.
    const [only] = makeHighlightsExclusive([
      makeEvent({ videoTimeMs: 1000, endTimeMs: 1100, fadeOut: 500, swipeDuration: 300 }),
    ])

    expect(only!.fadeOut).toBe(50)
    expect(only!.swipeDuration).toBe(100)
    expect(only!.endTimeMs - only!.videoTimeMs - only!.fadeOut).toBeGreaterThan(0)
  })

  it('sorts by start time before clamping', () => {
    const result = makeHighlightsExclusive([
      makeEvent({ videoTimeMs: 3000, endTimeMs: 9000 }),
      makeEvent({ videoTimeMs: 1000, endTimeMs: 9000 }),
    ])

    expect(result.map((e) => e.videoTimeMs)).toEqual([1000, 3000])
    expect(result[0]!.endTimeMs).toBe(3000)
  })

  it('shrinks a crowded mark into the gap before the next one', () => {
    const [first, second] = makeHighlightsExclusive([
      makeEvent({ videoTimeMs: 1000, endTimeMs: 5000, fadeOut: 400, swipeDuration: 300 }),
      makeEvent({ videoTimeMs: 1100, endTimeMs: 5000 }),
    ])

    expect(first!.endTimeMs).toBe(1100)
    expect(first!.endTimeMs).toBeLessThanOrEqual(second!.videoTimeMs)
    expect(first!.swipeDuration).toBe(100)
    expect(first!.fadeOut).toBe(50)
  })

  it('drops an empty mark instead of emitting a zero-length clip', () => {
    const result = makeHighlightsExclusive([
      makeEvent({ videoTimeMs: 1000, endTimeMs: 1000 }),
      makeEvent({ videoTimeMs: 1000, endTimeMs: 5000, width: 20 }),
      makeEvent({ videoTimeMs: 9000, endTimeMs: 9000 }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0]!.width).toBe(20)
  })

  it('drops a mark that shares its start with the next one', () => {
    const result = makeHighlightsExclusive([
      makeEvent({ videoTimeMs: 1000, endTimeMs: 5000, width: 10 }),
      makeEvent({ videoTimeMs: 1000, endTimeMs: 5000, width: 20 }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0]!.width).toBe(20)
  })

  it('shrinks fadeOut so the clamped window stays a positive clip length', () => {
    const [first] = makeHighlightsExclusive([
      makeEvent({ videoTimeMs: 0, endTimeMs: 4000, fadeOut: 500 }),
      makeEvent({ videoTimeMs: 300, endTimeMs: 4000, fadeOut: 500 }),
    ])

    // renderer builds the clip as end - start - fadeOut; it must stay > 0
    expect(first!.endTimeMs - first!.videoTimeMs - first!.fadeOut).toBeGreaterThan(0)
    expect(first!.fadeOut).toBeLessThanOrEqual(500)
  })

  it('returns a new array and does not mutate its input', () => {
    const input = [
      makeEvent({ videoTimeMs: 0, endTimeMs: 4500 }),
      makeEvent({ videoTimeMs: 1000, endTimeMs: 4500 }),
    ]
    const snapshot = structuredClone(input)

    makeHighlightsExclusive(input)

    expect(input).toEqual(snapshot)
  })
})

describe('shiftHighlightsForFreezes()', () => {
  it('keeps the configured duration when a freeze lands inside the window', () => {
    const [shifted] = shiftHighlightsForFreezes(
      [makeEvent({ videoTimeMs: 1000, endTimeMs: 3000 })],
      [{ atVideoMs: 1200, durationMs: 7000 }],
    )

    // The hold starts after the mark appears, so the mark is not pushed back —
    // and it still lasts 2s of finished video rather than 2s + the 7s hold.
    expect(shifted!.videoTimeMs).toBe(1000)
    expect(shifted!.endTimeMs - shifted!.videoTimeMs).toBe(2000)
  })

  it('pushes a highlight back past the freezes that precede it', () => {
    const [shifted] = shiftHighlightsForFreezes(
      [makeEvent({ videoTimeMs: 5000, endTimeMs: 7000 })],
      [{ atVideoMs: 1000, durationMs: 3000 }, { atVideoMs: 2000, durationMs: 500 }],
    )

    expect(shifted!.videoTimeMs).toBe(8500)
    expect(shifted!.endTimeMs).toBe(10_500)
  })

  it('is a no-op without freezes and never mutates its input', () => {
    const input = [makeEvent({ videoTimeMs: 100, endTimeMs: 900 })]
    const snapshot = structuredClone(input)

    expect(shiftHighlightsForFreezes(input, [])).toEqual(input)
    expect(input).toEqual(snapshot)
  })

  it('cannot reintroduce an overlap between clamped neighbours', () => {
    const clamped = makeHighlightsExclusive([
      makeEvent({ videoTimeMs: 1000, endTimeMs: 9000 }),
      makeEvent({ videoTimeMs: 2000, endTimeMs: 9000 }),
    ])
    const shifted = shiftHighlightsForFreezes(clamped, [{ atVideoMs: 1500, durationMs: 6000 }])

    expect(shifted[0]!.endTimeMs).toBeLessThanOrEqual(shifted[1]!.videoTimeMs)
  })
})
