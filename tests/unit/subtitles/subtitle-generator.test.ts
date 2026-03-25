import { describe, it, expect } from 'vitest'
import { generateSubtitles } from '../../../src/subtitles/subtitle-generator'
import { toMonotonic } from '../../../src/types/trace'
import type { TraceAction } from '../../../src/types/trace'
import type { SpeedMappedTrace } from '../../../src/types/speed'

function makeAction(
  start: number,
  end: number,
  overrides: Partial<TraceAction> = {},
): TraceAction {
  return {
    callId: `call-${start}`,
    title: `locator.click`,
    class: 'Locator',
    method: 'click',
    params: {},
    startTime: toMonotonic(start),
    endTime: toMonotonic(end),
    ...overrides,
  }
}

function makeSpeedMappedTrace(
  actions: TraceAction[],
  timeRemap?: (t: number) => number,
): SpeedMappedTrace {
  const remap = timeRemap ?? ((t: number) => t)
  return {
    metadata: {
      browserName: 'chromium',
      platform: 'linux',
      viewport: { width: 1280, height: 720 },
      startTime: toMonotonic(0),
      endTime: toMonotonic(10000),
      wallTime: Date.now(),
    },
    frames: [],
    actions,
    resources: [],
    events: [],
    cursorPositions: [],
    frameReader: {
      readFrame: async () => Buffer.alloc(0),
      dispose: () => {},
    },
    originalActions: actions,
    hiddenRanges: [],
    speedSegments: [],
    timeRemap: remap as any,
    outputDuration: 10000,
  }
}

describe('generateSubtitles', () => {
  it('generates subtitles from actions with keyword and text', () => {
    const actions = [
      makeAction(0, 2000, { keyword: 'When', text: 'user clicks the button' }),
      makeAction(3000, 5000, { keyword: 'Then', text: 'the page updates' }),
    ]
    const trace = makeSpeedMappedTrace(actions)

    const result = generateSubtitles(trace, (a) => a.text)

    expect(result.subtitles).toHaveLength(2)
    expect(result.subtitles[0]).toEqual({
      index: 1,
      startMs: 0,
      endMs: 2000,
      text: 'user clicks the button',
      keyword: 'When',
    })
    expect(result.subtitles[1]).toEqual({
      index: 2,
      startMs: 3000,
      endMs: 5000,
      text: 'the page updates',
      keyword: 'Then',
    })
  })

  it('skips actions where textFn returns undefined', () => {
    const actions = [
      makeAction(0, 1000, { text: 'visible' }),
      makeAction(1000, 2000), // no text or docString
      makeAction(2000, 3000, { text: 'also visible' }),
    ]
    const trace = makeSpeedMappedTrace(actions)

    const result = generateSubtitles(trace, (a) => a.text)

    expect(result.subtitles).toHaveLength(2)
    expect(result.subtitles[0]!.text).toBe('visible')
    expect(result.subtitles[1]!.text).toBe('also visible')
  })

  it('applies time remapping', () => {
    const actions = [
      makeAction(0, 4000, { text: 'step one' }),
      makeAction(4000, 8000, { text: 'step two' }),
    ]
    // Simulate 2x speed: all times are halved
    const trace = makeSpeedMappedTrace(actions, (t) => t / 2)

    const result = generateSubtitles(trace, (a) => a.text)

    expect(result.subtitles).toHaveLength(2)
    expect(result.subtitles[0]!.startMs).toBe(0)
    expect(result.subtitles[0]!.endMs).toBe(2000)
    expect(result.subtitles[1]!.startMs).toBe(2000)
    expect(result.subtitles[1]!.endMs).toBe(4000)
  })

  it('uses sequential index numbering', () => {
    const actions = [
      makeAction(0, 1000, { text: 'first' }),
      makeAction(1000, 2000), // skipped (no text)
      makeAction(2000, 3000, { text: 'second' }),
      makeAction(3000, 4000, { text: 'third' }),
    ]
    const trace = makeSpeedMappedTrace(actions)

    const result = generateSubtitles(trace, (a) => a.text)

    expect(result.subtitles).toHaveLength(3)
    expect(result.subtitles[0]!.index).toBe(1)
    expect(result.subtitles[1]!.index).toBe(2)
    expect(result.subtitles[2]!.index).toBe(3)
  })

  it('skips zero-duration entries after remapping', () => {
    const actions = [
      makeAction(1000, 1000, { text: 'zero duration' }),
      makeAction(2000, 3000, { text: 'valid' }),
    ]
    const trace = makeSpeedMappedTrace(actions)

    const result = generateSubtitles(trace, (a) => a.text)

    // The zero-duration action should be skipped (endMs <= startMs)
    expect(result.subtitles).toHaveLength(1)
    expect(result.subtitles[0]!.text).toBe('valid')
    expect(result.subtitles[0]!.index).toBe(1)
  })

  it('uses docString via textFn when available', () => {
    const actions = [
      makeAction(0, 2000, {
        keyword: 'When',
        text: 'step text',
        docString: 'Detailed voiceover narration',
      }),
    ]
    const trace = makeSpeedMappedTrace(actions)

    const result = generateSubtitles(trace, (a) => a.docString ?? a.text)

    expect(result.subtitles).toHaveLength(1)
    expect(result.subtitles[0]!.text).toBe('Detailed voiceover narration')
  })

  it('returns empty subtitles for empty actions', () => {
    const trace = makeSpeedMappedTrace([])

    const result = generateSubtitles(trace, (a) => a.text)

    expect(result.subtitles).toEqual([])
  })

  it('preserves the original trace fields in the result', () => {
    const actions = [makeAction(0, 1000, { text: 'hi' })]
    const trace = makeSpeedMappedTrace(actions)

    const result = generateSubtitles(trace, (a) => a.text)

    expect(result.actions).toBe(trace.actions)
    expect(result.speedSegments).toBe(trace.speedSegments)
    expect(result.metadata).toBe(trace.metadata)
  })
})
