import { describe, it, expect } from 'vitest'
import {
  buildNarrationSubtitles,
  sceneOf,
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
  it('records the raw trace time of the marker closing each window', () => {
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}First`, 1000.4),
      mkNarrate(WAIT_FOR_NARRATION_TITLE_PREFIX, 1000.9),
      mkNarrate(`${NARRATE_TITLE_PREFIX}Last`, 5000),
    ]
    const subs = buildNarrationSubtitles(actions, (t) => t, 9000)
    expect(subs[0]!.endTraceMs).toBe(1000.9)
    expect(subs[1]!.endTraceMs).toBeUndefined()
  })

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
    expect(subs).toMatchObject([
      { index: 1, startMs: 1000, endMs: 4000, text: 'Hello' },
      { index: 2, startMs: 4000, endMs: 10_000, text: 'World' },
    ])
  })

  it('without waitForNarration: final narrate ends at trace end', () => {
    const actions = [mkNarrate(`${NARRATE_TITLE_PREFIX}Only`, 2000)]
    const subs = buildNarrationSubtitles(actions, identity, traceEndMs)
    expect(subs).toMatchObject([{ index: 1, startMs: 2000, endMs: 10_000, text: 'Only' }])
  })

  it('hidden narrations are excluded from output but still bound visible windows', () => {
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}Visible`, 1000),
      mkNarrate(`${NARRATE_HIDDEN_TITLE_PREFIX}secret`, 3000),
    ]
    const subs = buildNarrationSubtitles(actions, identity, traceEndMs)
    expect(subs).toMatchObject([{ index: 1, startMs: 1000, endMs: 3000, text: 'Visible' }])
  })

  it('with waitForNarration marker between two narrates: first window ends at the marker', () => {
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}First line`, 1000),
      mkNarrate(WAIT_FOR_NARRATION_TITLE_PREFIX, 2500),
      mkNarrate(`${NARRATE_TITLE_PREFIX}Second line`, 6000),
    ]
    const subs = buildNarrationSubtitles(actions, identity, traceEndMs)
    expect(subs).toMatchObject([
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
    expect(subs).toMatchObject([{ index: 1, startMs: 1000, endMs: 4000, text: 'Last line' }])
  })

  it('picks the earliest of next-narrate and next-waitForNarration', () => {
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}First`, 1000),
      mkNarrate(`${NARRATE_TITLE_PREFIX}Second`, 2000),
      mkNarrate(WAIT_FOR_NARRATION_TITLE_PREFIX, 5000),
      mkNarrate(`${NARRATE_TITLE_PREFIX}Third`, 7000),
    ]
    const subs = buildNarrationSubtitles(actions, identity, traceEndMs)
    expect(subs).toMatchObject([
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
    expect(subs).toMatchObject([
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
    expect(subs).toMatchObject([
      { index: 1, startMs: 5000, endMs: 5000, text: 'A' },
      { index: 2, startMs: 5000, endMs: 10_000, text: 'B' },
    ])
  })
})

describe('sceneOf()', () => {
  // Parent chain as Playwright Test 1.60 traces it.
  const step = (callId: string, title: string, parentId?: string) => ({ callId, method: 'test.step', title, ...(parentId ? { parentId } : {}) })
  const narrate = (callId: string, parentId?: string) => step(callId, `${NARRATE_TITLE_PREFIX}line`, parentId)
  const actions = [
    { callId: 'hook@1', method: 'hook', title: 'Before Hooks' },
    { callId: 'fixture@3', method: 'fixture', title: 'Fixture "page"', parentId: 'hook@1' },
    step('test.step@4', 'Background', 'hook@1'),
    narrate('test.step@5', 'test.step@4'),
    step('test.step@41', '5. publish'),
    narrate('test.step@43', 'test.step@41'),
    step('test.step@44', 'zoomDialog', 'test.step@41'),
    step('test.step@45', 'zoom marker', 'test.step@44'),
    step('test.step@46', 'open dialog'),
    step('test.step@47', 'zoom marker', 'test.step@46'),
    narrate('test.step@48'),
  ]
  const of = sceneOf(actions)
  const at = (id: string) => actions.find((a) => a.callId === id)!

  it('is the outermost step holding a narration, through helper steps', () => {
    expect(of(at('test.step@45'))).toBe('test.step@41')
    expect(of(at('test.step@43'))).toBe('test.step@41')
  })

  it('counts a beforeEach step on its own, skipping the hook container', () => {
    expect(of(at('test.step@5'))).toBe('test.step@4')
    expect(of(at('fixture@3'))).toBeUndefined()
  })

  it('is undefined in a step without narration and in the test body', () => {
    expect(of(at('test.step@47'))).toBeUndefined()
    expect(of(at('test.step@48'))).toBeUndefined()
  })

  it('is undefined for a broken parent chain', () => {
    expect(of({ parentId: 'gone@1' })).toBeUndefined()
  })

  it('makes no scene of a step that holds only hidden narrations, which get no cue', () => {
    const hidden = sceneOf([
      { callId: 'test.step@1', method: 'test.step', title: 'setup' },
      { callId: 'test.step@2', method: 'test.step', title: `${NARRATE_HIDDEN_TITLE_PREFIX}quiet`, parentId: 'test.step@1' },
      { callId: 'test.step@3', method: 'test.step', title: 'zoom marker', parentId: 'test.step@1' },
    ])
    expect(hidden({ parentId: 'test.step@1' })).toBeUndefined()
  })
})
