import { describe, it, expect } from 'vitest'
import {
  buildNarrationSubtitles,
  type NarrationMarkerAction,
} from '../../../src/pipeline/narration-subtitles'
import {
  NARRATE_TITLE_PREFIX,
  NARRATE_HIDDEN_TITLE_PREFIX,
  WAIT_FOR_NARRATION_TITLE_PREFIX,
} from '../../../src/helpers'

function mkNarrate(title: string, startTime: number): NarrationMarkerAction {
  return { title, startTime }
}

describe('buildNarrationSubtitles', () => {
  const identity = (t: number) => t
  const traceEndMs = 10_000

  it('returns empty list when there are no narrate markers', () => {
    const subs = buildNarrationSubtitles([], identity, traceEndMs)
    expect(subs).toEqual([])
  })

  it('without waitForNarration: each narrate ends at the next narrate (existing behaviour)', () => {
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}Hello`, 1000),
      mkNarrate(`${NARRATE_TITLE_PREFIX}World`, 4000),
    ]
    const subs = buildNarrationSubtitles(actions, identity, traceEndMs)
    expect(subs).toEqual([
      { index: 1, startMs: 1000, endMs: 4000, text: 'Hello' },
      { index: 2, startMs: 4000, endMs: 10_000, text: 'World' },
    ])
  })

  it('without waitForNarration: final narrate ends at trace end', () => {
    const actions = [mkNarrate(`${NARRATE_TITLE_PREFIX}Only`, 2000)]
    const subs = buildNarrationSubtitles(actions, identity, traceEndMs)
    expect(subs).toEqual([{ index: 1, startMs: 2000, endMs: 10_000, text: 'Only' }])
  })

  it('hidden narrations are excluded from output but still bound visible windows', () => {
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}Visible`, 1000),
      mkNarrate(`${NARRATE_HIDDEN_TITLE_PREFIX}secret`, 3000),
    ]
    const subs = buildNarrationSubtitles(actions, identity, traceEndMs)
    expect(subs).toEqual([{ index: 1, startMs: 1000, endMs: 3000, text: 'Visible' }])
  })

  it('with waitForNarration marker between two narrates: first window ends at the marker', () => {
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}First line`, 1000),
      mkNarrate(WAIT_FOR_NARRATION_TITLE_PREFIX, 2500),
      mkNarrate(`${NARRATE_TITLE_PREFIX}Second line`, 6000),
    ]
    const subs = buildNarrationSubtitles(actions, identity, traceEndMs)
    expect(subs).toEqual([
      { index: 1, startMs: 1000, endMs: 2500, text: 'First line' },
      { index: 2, startMs: 6000, endMs: 10_000, text: 'Second line' },
    ])
  })

  it('with waitForNarration after the final narrate: window ends at the marker, not trace end', () => {
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}Last line`, 1000),
      mkNarrate(WAIT_FOR_NARRATION_TITLE_PREFIX, 4000),
    ]
    const subs = buildNarrationSubtitles(actions, identity, traceEndMs)
    expect(subs).toEqual([{ index: 1, startMs: 1000, endMs: 4000, text: 'Last line' }])
  })

  it('picks the earliest of next-narrate and next-waitForNarration', () => {
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}First`, 1000),
      mkNarrate(`${NARRATE_TITLE_PREFIX}Second`, 2000),
      mkNarrate(WAIT_FOR_NARRATION_TITLE_PREFIX, 5000),
      mkNarrate(`${NARRATE_TITLE_PREFIX}Third`, 7000),
    ]
    const subs = buildNarrationSubtitles(actions, identity, traceEndMs)
    expect(subs).toEqual([
      { index: 1, startMs: 1000, endMs: 2000, text: 'First' },
      { index: 2, startMs: 2000, endMs: 5000, text: 'Second' },
      { index: 3, startMs: 7000, endMs: 10_000, text: 'Third' },
    ])
  })

  it('time-remap function is applied to start/end positions', () => {
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}A`, 1000),
      mkNarrate(`${NARRATE_TITLE_PREFIX}B`, 2000),
    ]
    const remap = (t: number) => t * 2
    const subs = buildNarrationSubtitles(actions, remap, 6000)
    expect(subs).toEqual([
      { index: 1, startMs: 2000, endMs: 4000, text: 'A' },
      { index: 2, startMs: 4000, endMs: 6000, text: 'B' },
    ])
  })

  it('keeps zero-width narrations (voiceover/renderer size them downstream)', () => {
    // On a fast trace (no autoWait), a narrate() immediately followed by another
    // narrate()/waitForNarration() collapses the window to ~0. The line must be
    // kept (clamped, never inverted) so voiceover can later stretch it to the
    // audio length; the renderer drops any still-zero-duration line before burn-in.
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}A`, 5000),
      mkNarrate(`${NARRATE_TITLE_PREFIX}B`, 5000),
    ]
    const subs = buildNarrationSubtitles(actions, identity, 10_000)
    expect(subs).toEqual([
      { index: 1, startMs: 5000, endMs: 5000, text: 'A' },
      { index: 2, startMs: 5000, endMs: 10_000, text: 'B' },
    ])
  })
})
