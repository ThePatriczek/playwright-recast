import { describe, it, expect } from 'vitest'
import { groupActions, type RawAction } from '../analyzer.js'

function action(overrides: Partial<RawAction>): RawAction {
  return {
    callId: `call-${Math.random().toString(36).slice(2, 8)}`,
    method: 'click',
    params: {},
    startTime: 0,
    endTime: 100,
    title: '',
    ...overrides,
  }
}

describe('groupActions', () => {
  it('marks initial goto as hidden', () => {
    const actions: RawAction[] = [
      action({ method: 'goto', params: { url: 'https://app.example.com' }, title: 'goto' }),
      action({ method: 'click', params: { selector: 'button.submit' }, title: 'click', startTime: 1000, endTime: 1100 }),
    ]
    const steps = groupActions(actions)
    expect(steps[0].hidden).toBe(true)
    expect(steps[1].hidden).toBe(false)
  })

  it('marks login sequence as hidden', () => {
    const actions: RawAction[] = [
      action({ method: 'goto', params: { url: 'https://app.example.com/login' }, title: 'goto' }),
      action({ method: 'fill', params: { selector: 'input[name="email"]', value: 'user@test.com' }, title: 'fill', startTime: 500, endTime: 600 }),
      action({ method: 'fill', params: { selector: 'input[type="password"]', value: '***' }, title: 'fill', startTime: 700, endTime: 800 }),
      action({ method: 'click', params: { selector: 'button[type="submit"]' }, title: 'click', startTime: 900, endTime: 1000 }),
      action({ method: 'click', params: { selector: 'button.feature' }, title: 'click', startTime: 5000, endTime: 5100 }),
    ]
    const steps = groupActions(actions)
    const hidden = steps.filter((s) => s.hidden)
    const visible = steps.filter((s) => !s.hidden)
    expect(hidden.length).toBeGreaterThanOrEqual(1)
    expect(visible.length).toBeGreaterThanOrEqual(1)
  })

  it('groups click + fill on same area into one step', () => {
    const actions: RawAction[] = [
      action({ method: 'click', params: { selector: '.search-input' }, title: 'click', startTime: 0, endTime: 100 }),
      action({ method: 'fill', params: { selector: '.search-input', value: 'report' }, title: 'fill', startTime: 200, endTime: 300 }),
    ]
    const steps = groupActions(actions)
    expect(steps.length).toBe(1)
    expect(steps[0].actionIndices).toEqual([0, 1])
  })

  it('splits actions with >5s time gap into separate steps', () => {
    const actions: RawAction[] = [
      action({ method: 'click', params: { selector: '.btn-a' }, title: 'click', startTime: 0, endTime: 100 }),
      action({ method: 'click', params: { selector: '.btn-b' }, title: 'click', startTime: 10000, endTime: 10100 }),
    ]
    const steps = groupActions(actions)
    expect(steps.length).toBe(2)
  })

  it('generates human-readable labels', () => {
    const actions: RawAction[] = [
      action({ method: 'goto', params: { url: 'https://app.example.com/dashboard' }, title: 'goto', startTime: 0, endTime: 100 }),
      action({ method: 'click', params: { selector: 'button' }, title: 'click "Download"', startTime: 5000, endTime: 5100 }),
    ]
    const steps = groupActions(actions)
    const visible = steps.filter((s) => !s.hidden)
    expect(visible[0].label).toContain('Download')
  })

  it('handles empty actions array', () => {
    const steps = groupActions([])
    expect(steps).toEqual([])
  })

  it('handles single action', () => {
    const actions: RawAction[] = [
      action({ method: 'click', params: { selector: '.btn' }, title: 'click "Save"', startTime: 0, endTime: 100 }),
    ]
    const steps = groupActions(actions)
    expect(steps.length).toBe(1)
    expect(steps[0].hidden).toBe(false)
  })

  it('marks cookie consent actions as hidden', () => {
    const actions: RawAction[] = [
      action({ method: 'click', params: { selector: '.cookie-consent-accept' }, title: 'click', startTime: 0, endTime: 100 }),
      action({ method: 'click', params: { selector: '.main-content' }, title: 'click "Start"', startTime: 5000, endTime: 5100 }),
    ]
    const steps = groupActions(actions)
    expect(steps[0].hidden).toBe(true)
    expect(steps[1].hidden).toBe(false)
  })

  it('marks voiceover-hidden annotated actions as hidden', () => {
    const actions: RawAction[] = [
      action({
        method: 'click',
        params: { selector: '.setup-btn' },
        title: 'click',
        startTime: 0,
        endTime: 100,
        annotations: [{ type: 'voiceover-hidden' }],
      }),
      action({ method: 'click', params: { selector: '.feature-btn' }, title: 'click "Feature"', startTime: 5000, endTime: 5100 }),
    ]
    const steps = groupActions(actions)
    expect(steps[0].hidden).toBe(true)
    expect(steps[1].hidden).toBe(false)
  })

  it('masks password values', () => {
    const actions: RawAction[] = [
      action({
        method: 'fill',
        params: { selector: 'input[type="password"]', value: 'secret123' },
        title: 'fill',
        startTime: 0,
        endTime: 100,
      }),
    ]
    const steps = groupActions(actions)
    // The step is hidden (password field), but the action value should be masked
    const passwordAction = steps[0].actions.find((a) => a.method === 'fill')
    expect(passwordAction?.value).toBe('***')
  })

  it('generates "Navigate to" label for goto', () => {
    const actions: RawAction[] = [
      action({ method: 'goto', params: { url: 'https://app.example.com/reports' }, title: 'goto', startTime: 5000, endTime: 5100 }),
    ]
    // First goto is hidden; use a second goto that won't be hidden
    const allActions: RawAction[] = [
      action({ method: 'goto', params: { url: 'https://app.example.com/' }, title: 'goto', startTime: 0, endTime: 100 }),
      action({ method: 'click', params: { selector: '.something' }, title: 'click', startTime: 1000, endTime: 1100 }),
      action({ method: 'goto', params: { url: 'https://app.example.com/reports' }, title: 'goto', startTime: 6000, endTime: 6100 }),
    ]
    const steps = groupActions(allActions)
    const gotoStep = steps.find((s) => !s.hidden && s.label.includes('Navigate'))
    expect(gotoStep).toBeDefined()
    expect(gotoStep!.label).toContain('reports')
  })

  it('generates "Search for" label for click + fill combo', () => {
    const actions: RawAction[] = [
      action({ method: 'click', params: { selector: '.search-input' }, title: 'click', startTime: 0, endTime: 100 }),
      action({ method: 'fill', params: { selector: '.search-input', value: 'quarterly report' }, title: 'fill', startTime: 200, endTime: 300 }),
    ]
    const steps = groupActions(actions)
    expect(steps[0].label).toContain('quarterly report')
  })

  it('generates "Select" label for selectOption', () => {
    const actions: RawAction[] = [
      action({ method: 'selectOption', params: { selector: 'select.region', values: ['Europe'] }, title: 'selectOption', startTime: 0, endTime: 100 }),
    ]
    const steps = groupActions(actions)
    expect(steps[0].label).toContain('Select')
  })

  it('merges consecutive hidden actions into one hidden step', () => {
    const actions: RawAction[] = [
      action({ method: 'goto', params: { url: 'https://app.example.com/login' }, title: 'goto', startTime: 0, endTime: 100 }),
      action({ method: 'fill', params: { selector: 'input[name="email"]', value: 'user@test.com' }, title: 'fill', startTime: 200, endTime: 300 }),
      action({ method: 'fill', params: { selector: 'input[type="password"]', value: 'pass' }, title: 'fill', startTime: 400, endTime: 500 }),
      action({ method: 'click', params: { selector: 'button[type="submit"]' }, title: 'click', startTime: 600, endTime: 700 }),
    ]
    const steps = groupActions(actions)
    const hidden = steps.filter((s) => s.hidden)
    // All four login actions should be merged into a single hidden "Setup" step
    expect(hidden.length).toBe(1)
    expect(hidden[0].label).toBe('Setup')
  })

  it('preserves correct actionIndices referencing original array', () => {
    const actions: RawAction[] = [
      action({ method: 'goto', params: { url: 'https://app.example.com' }, title: 'goto', startTime: 0, endTime: 100 }),
      action({ method: 'click', params: { selector: '.search' }, title: 'click', startTime: 1000, endTime: 1100 }),
      action({ method: 'fill', params: { selector: '.search', value: 'test' }, title: 'fill', startTime: 1200, endTime: 1300 }),
      action({ method: 'click', params: { selector: '.submit' }, title: 'click "Submit"', startTime: 7000, endTime: 7100 }),
    ]
    const steps = groupActions(actions)
    // First step: hidden goto at index 0
    expect(steps[0].actionIndices).toEqual([0])
    // Second step: click + fill merged at indices 1, 2
    expect(steps[1].actionIndices).toEqual([1, 2])
    // Third step: submit click at index 3
    expect(steps[2].actionIndices).toEqual([3])
  })

  it('strips data-testid from selectors in action output', () => {
    const actions: RawAction[] = [
      action({
        method: 'click',
        params: { selector: '[data-testid="save-button"]' },
        title: 'click "Save"',
        startTime: 0,
        endTime: 100,
      }),
    ]
    const steps = groupActions(actions)
    const clickAction = steps[0].actions[0]
    expect(clickAction.selector).not.toContain('data-testid')
  })

  it('computes correct timing for steps', () => {
    const actions: RawAction[] = [
      action({ method: 'click', params: { selector: '.btn-a' }, title: 'click', startTime: 1000, endTime: 1200 }),
      action({ method: 'click', params: { selector: '.btn-b' }, title: 'click', startTime: 1500, endTime: 1700 }),
    ]
    const steps = groupActions(actions)
    // These are within 5s so they should be grouped
    expect(steps.length).toBe(1)
    expect(steps[0].startTimeMs).toBe(1000)
    expect(steps[0].endTimeMs).toBe(1700)
    expect(steps[0].durationMs).toBe(700)
  })
})
