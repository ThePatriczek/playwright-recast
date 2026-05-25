import { describe, it, expect } from 'vitest'
import { filterSteps } from '../../../src/filter/step-filter'
import { toMonotonic } from '../../../src/types/trace'
import type { ParsedTrace, TraceAction } from '../../../src/types/trace'

function makeAction(keyword: string, text: string, start: number, end: number): TraceAction {
  return {
    callId: `call-${start}`,
    title: `${keyword} ${text}`,
    class: 'test.step',
    method: keyword.toLowerCase(),
    params: {},
    startTime: toMonotonic(start),
    endTime: toMonotonic(end),
    keyword,
    text,
  }
}

function makeTrace(actions: TraceAction[]): ParsedTrace {
  return {
    metadata: {
      browserName: 'chromium',
      platform: 'darwin',
      viewport: { width: 1920, height: 1080 },
      startTime: toMonotonic(0),
      endTime: toMonotonic(20000),
      wallTime: Date.now(),
    },
    frames: [],
    actions,
    resources: [],
    events: [],
    cursorPositions: [],
    frameReader: { readFrame: async () => Buffer.from(''), dispose: () => {} },
  }
}

describe('filterSteps', () => {
  it('removes actions matching the predicate', () => {
    const actions = [
      makeAction('Given', 'the user is logged in', 0, 5000),
      makeAction('Given', 'the user opens marketplace', 5000, 8000),
      makeAction('When', 'the user clicks something', 8000, 10000),
    ]
    const trace = makeTrace(actions)

    const result = filterSteps(trace, (a) => a.text === 'the user is logged in')

    expect(result.actions).toHaveLength(2)
    expect(result.actions[0]!.text).toBe('the user opens marketplace')
    expect(result.actions[1]!.text).toBe('the user clicks something')
  })

  it('preserves original actions', () => {
    const actions = [
      makeAction('Given', 'hidden step', 0, 5000),
      makeAction('When', 'visible step', 5000, 10000),
    ]
    const trace = makeTrace(actions)

    const result = filterSteps(trace, (a) => a.text === 'hidden step')

    expect(result.originalActions).toHaveLength(2)
    expect(result.actions).toHaveLength(1)
  })

  it('records hidden time ranges', () => {
    const actions = [
      makeAction('Given', 'hidden step', 1000, 5000),
      makeAction('When', 'visible step', 5000, 10000),
    ]
    const trace = makeTrace(actions)

    const result = filterSteps(trace, (a) => a.text === 'hidden step')

    expect(result.hiddenRanges).toEqual([
      { start: toMonotonic(1000), end: toMonotonic(5000) },
    ])
  })

  it('handles multiple hidden ranges', () => {
    const actions = [
      makeAction('Given', 'setup 1', 0, 3000),
      makeAction('When', 'visible', 3000, 6000),
      makeAction('When', 'setup 2', 6000, 9000),
      makeAction('Then', 'assertion', 9000, 12000),
    ]
    const trace = makeTrace(actions)

    const result = filterSteps(trace, (a) => a.text?.startsWith('setup') ?? false)

    expect(result.actions).toHaveLength(2)
    expect(result.hiddenRanges).toHaveLength(2)
  })

  it('drops child actions whose time falls inside a hidden parent step', () => {
    const parent: TraceAction = {
      callId: 'parent',
      title: 'login',
      class: 'test.step',
      method: 'step',
      params: {},
      startTime: toMonotonic(1000),
      endTime: toMonotonic(5000),
    }
    const childClickA: TraceAction = {
      callId: 'child-a',
      title: 'click submit',
      class: 'Locator',
      method: 'click',
      params: {},
      startTime: toMonotonic(1500),
      endTime: toMonotonic(1600),
      parentId: 'parent',
      point: { x: 10, y: 20, timestamp: toMonotonic(1500) },
    }
    const childClickB: TraceAction = {
      callId: 'child-b',
      title: 'click next',
      class: 'Locator',
      method: 'click',
      params: {},
      startTime: toMonotonic(2500),
      endTime: toMonotonic(2600),
      parentId: 'parent',
      point: { x: 30, y: 40, timestamp: toMonotonic(2500) },
    }
    const visibleClick: TraceAction = {
      callId: 'visible',
      title: 'click after',
      class: 'Locator',
      method: 'click',
      params: {},
      startTime: toMonotonic(6000),
      endTime: toMonotonic(6100),
      point: { x: 50, y: 60, timestamp: toMonotonic(6000) },
    }
    const trace = makeTrace([parent, childClickA, childClickB, visibleClick])

    const result = filterSteps(trace, (a) => a.title === 'login')

    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]!.callId).toBe('visible')
    expect(result.hiddenRanges).toEqual([
      { start: toMonotonic(1000), end: toMonotonic(5000) },
    ])
    expect(result.originalActions).toHaveLength(4)
  })

  it('returns unchanged trace when no actions match', () => {
    const actions = [
      makeAction('When', 'step 1', 0, 5000),
      makeAction('Then', 'step 2', 5000, 10000),
    ]
    const trace = makeTrace(actions)

    const result = filterSteps(trace, () => false)

    expect(result.actions).toHaveLength(2)
    expect(result.hiddenRanges).toHaveLength(0)
  })
})
