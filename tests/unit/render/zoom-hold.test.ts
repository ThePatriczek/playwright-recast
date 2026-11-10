import { describe, it, expect } from 'vitest'
import { buildSegments, stepZoomsToKeyframes } from '../../../src/render/zoom-expression'

const cue = (startMs: number, endMs: number, zoom?: { hold?: boolean }) => ({
  startMs, endMs, ...(zoom ? { zoom: { x: 0.2, y: 0.2, level: 2, ...zoom } } : {}),
})
const T = { transitionMs: 400, containInCue: false }
const ends = (kfs: ReturnType<typeof stepZoomsToKeyframes>) => kfs.map((k) => k.atMs + (k.transitionMs ?? 0))

describe('stepZoomsToKeyframes() with hold', () => {
  it('ends a plain zoom with its cue', () => {
    expect(ends(stepZoomsToKeyframes([cue(0, 1000, {}), cue(3000, 4000)], T))).toEqual([1000])
  })

  it('holds through the pause until the next cue, leaving one transition to reach it', () => {
    expect(ends(stepZoomsToKeyframes([cue(0, 1000, { hold: true }), cue(3000, 4000)], T))).toEqual([2600])
  })

  it('holds into a next zoom on the same cue chain without a zoom-out between them', () => {
    const kfs = stepZoomsToKeyframes([cue(0, 1000, { hold: true }), cue(2500, 4000, {})], T)
    expect(ends(kfs)).toEqual([2100, 4000])
  })

  it('never ends before its own cue', () => {
    expect(ends(stepZoomsToKeyframes([cue(0, 1000, { hold: true }), cue(1200, 2000)], T))).toEqual([1000])
  })

  it('ends with its cue when no cue follows', () => {
    expect(ends(stepZoomsToKeyframes([cue(0, 1000, { hold: true })], T))).toEqual([1000])
  })

  it('with containInCue, holds until the next cue, zooming out inside the held window', () => {
    const kfs = stepZoomsToKeyframes([cue(0, 1000, { hold: true }), cue(3000, 4000)], { transitionMs: 400, containInCue: true })
    expect(ends(kfs)).toEqual([3000])
    const segments = buildSegments(kfs.map((k) => ({ atMs: k.atMs, holdMs: k.transitionMs!, x: k.x!, y: k.y!, level: k.level! })), 0.4, true)
    // Zoomed until the zoom-out that ends as the next narration starts: no full frame before it.
    expect(segments.at(-1)).toMatchObject({ type: 'transition', startSec: 2.6, endSec: 3, toLevel: 1 })
  })
})
