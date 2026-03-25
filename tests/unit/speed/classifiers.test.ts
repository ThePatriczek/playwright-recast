import { describe, it, expect } from 'vitest'
import { classifyTimepoint } from '../../../src/speed/classifiers'
import { toMonotonic } from '../../../src/types/trace'
import type { TraceAction, TraceResource } from '../../../src/types/trace'

function makeAction(start: number, end: number, method = 'click'): TraceAction {
  return {
    callId: `call-${start}`,
    title: `locator.${method}`,
    class: 'Locator',
    method,
    params: {},
    startTime: toMonotonic(start),
    endTime: toMonotonic(end),
  }
}

function makeNavigation(start: number, end: number): TraceAction {
  return {
    callId: `nav-${start}`,
    title: 'page.goto',
    class: 'Page',
    method: 'goto',
    params: {},
    startTime: toMonotonic(start),
    endTime: toMonotonic(end),
  }
}

function makeResource(start: number, end: number): TraceResource {
  return {
    url: 'https://api.example.com/data',
    method: 'GET',
    status: 200,
    startTime: toMonotonic(start),
    endTime: toMonotonic(end),
    mimeType: 'application/json',
  }
}

describe('classifyTimepoint', () => {
  it('returns "idle" when nothing is happening', () => {
    expect(
      classifyTimepoint(toMonotonic(5000), [], []),
    ).toBe('idle')
  })

  it('returns "user-action" during a click', () => {
    const actions = [makeAction(1000, 2000, 'click')]
    expect(classifyTimepoint(toMonotonic(1500), actions, [])).toBe('user-action')
  })

  it('returns "user-action" during a fill', () => {
    const actions = [makeAction(1000, 2000, 'fill')]
    expect(classifyTimepoint(toMonotonic(1500), actions, [])).toBe('user-action')
  })

  it('returns "navigation" during page.goto', () => {
    const actions = [makeNavigation(1000, 3000)]
    expect(classifyTimepoint(toMonotonic(2000), actions, [])).toBe('navigation')
  })

  it('returns "network-wait" during active network request', () => {
    const resources = [makeResource(1000, 5000)]
    expect(classifyTimepoint(toMonotonic(3000), [], resources)).toBe('network-wait')
  })

  it('user-action takes priority over network-wait', () => {
    const actions = [makeAction(2000, 3000)]
    const resources = [makeResource(1000, 5000)]
    expect(classifyTimepoint(toMonotonic(2500), actions, resources)).toBe('user-action')
  })

  it('navigation takes priority over network-wait', () => {
    const actions = [makeNavigation(2000, 4000)]
    const resources = [makeResource(1000, 5000)]
    expect(classifyTimepoint(toMonotonic(3000), actions, resources)).toBe('navigation')
  })

  it('user-action takes priority over navigation', () => {
    const actions = [
      makeAction(2000, 3000, 'click'),
      makeNavigation(1000, 4000),
    ]
    expect(classifyTimepoint(toMonotonic(2500), actions, [])).toBe('user-action')
  })
})
