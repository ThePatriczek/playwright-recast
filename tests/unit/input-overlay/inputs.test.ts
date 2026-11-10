import { describe, it, expect } from 'vitest'
import {
  collectMouseInputs, collectKeyInputs, keyLabel, parseInputOverrides, selectInputs,
} from '../../../src/input-overlay/inputs'
import { INPUT_TITLE_PREFIX } from '../../../src/helpers'
import { buildKeyOverlayEvents, buildMouseInputEvents } from '../../../src/input-overlay/events'
import { resolveMouseIndicatorConfig } from '../../../src/input-overlay/defaults'

const act = (method: string, startTime: number, params: Record<string, unknown> = {}, extra: object = {}) =>
  ({ method, startTime, endTime: startTime + 5, params, ...extra })
const pt = { point: { x: 1, y: 1 } }

describe('collectMouseInputs()', () => {
  it('spans a button from down to up, per button', () => {
    const inputs = collectMouseInputs([
      act('mouseDown', 1000, { button: 'right' }, pt),
      act('mouseMove', 1100, {}, pt),
      act('mouseUp', 2000, { button: 'right' }, pt),
      act('mouseDown', 3000, {}, pt),
      act('mouseUp', 3500, {}, pt),
    ])
    expect(inputs).toEqual([
      { input: 'right', startMs: 1005, endMs: 2005 },
      { input: 'left', startMs: 3005, endMs: 3505 },
    ])
  })

  it('reads clicks with their button and wheel turns with their direction', () => {
    const inputs = collectMouseInputs([
      act('click', 1000, { button: 'middle' }, pt),
      act('dblclick', 2000, {}, pt),
      act('mouseWheel', 3000, { deltaX: 0, deltaY: -120 }),
      act('mouseWheel', 4000, { deltaX: 50, deltaY: 0 }),
      act('fill', 5000, { value: 'x' }, pt),
    ])
    expect(inputs.map((i) => [i.input, i.direction])).toEqual([
      ['middle', undefined], ['left', undefined], ['wheel', 'up'], ['wheel', 'right'],
    ])
  })
})

describe('collectKeyInputs()', () => {
  it('reads combos, named keys and plain keys with the modifiers held', () => {
    const inputs = collectKeyInputs([
      act('keyboardPress', 1000, { key: 'ControlOrMeta+Z' }),
      act('press', 2000, { selector: 'x', key: 'Escape' }),
      act('keyboardPress', 3000, { key: 'Shift+Tab' }),
      act('keyboardPress', 4000, { key: 'a' }),
      act('keyboardDown', 5000, { key: 'Shift' }),
      act('keyboardPress', 5100, { key: 'KeyA' }),
      act('keyboardPress', 5200, { key: 'Control+Shift++' }),
      act('keyboardUp', 5300, { key: 'Shift' }),
    ])
    expect(inputs.map((i) => [i.keys, i.input])).toEqual([
      [['ControlOrMeta', 'Z'], 'combos'],
      [['Escape'], 'special'],
      [['Shift', 'Tab'], 'combos'],
      [['a'], 'keys'],
      [['Shift', 'KeyA'], 'keys'],
      [['Control', 'Shift', '+'], 'combos'],
    ])
  })

  it('names a modifier held over a drag, a click or a wheel turn', () => {
    const inputs = collectKeyInputs([
      act('keyboardDown', 1000, { key: 'Alt' }),
      act('mouseDown', 1100, {}, pt),
      act('mouseMove', 1200, {}, pt),
      act('mouseUp', 1300, {}, pt),
      act('keyboardUp', 1400, { key: 'Alt' }),
      act('keyboardDown', 2000, { key: 'Shift' }),
      act('mouseDown', 2100, {}, pt),
      act('mouseUp', 2200, {}, pt),
      act('keyboardUp', 2300, { key: 'Shift' }),
      act('click', 3000, { modifiers: ['Shift', 'Control'] }, pt),
      act('keyboardDown', 4000, { key: 'Control' }),
      act('mouseWheel', 4100, { deltaY: 100 }),
      act('keyboardUp', 4200, { key: 'Control' }),
      act('keyboardDown', 5000, { key: 'Shift' }),
      act('keyboardUp', 5100, { key: 'Shift' }),
    ])
    expect(inputs).toEqual([
      { keys: ['Alt', 'drag'], input: 'mouse-modifiers', startMs: 1005, endMs: 1405 },
      { keys: ['Shift', 'click'], input: 'mouse-modifiers', startMs: 2005, endMs: 2305 },
      { keys: ['Control', 'Shift', 'click'], input: 'mouse-modifiers', startMs: 3005, endMs: 3005 },
      { keys: ['Control', 'wheel'], input: 'mouse-modifiers', startMs: 4005, endMs: 4205 },
    ])
  })

  it('never reads typed text', () => {
    expect(collectKeyInputs([
      act('fill', 1000, { value: 'secret' }, pt),
      act('type', 2000, { text: 'abc' }),
      act('keyboardType', 3000, { text: 'abc' }),
      act('keyboardInsertText', 4000, { text: 'abc' }),
    ])).toEqual([])
  })
})

describe('keyLabel()', () => {
  it('uses platform-neutral labels, overridable', () => {
    expect(keyLabel(['ControlOrMeta', 'z'])).toBe('Ctrl + Z')
    expect(keyLabel(['Escape'])).toBe('Esc')
    expect(keyLabel(['Shift', 'KeyA'])).toBe('Shift + A')
    expect(keyLabel(['Alt', 'drag'], { drag: 'Drag', Alt: 'Option' }, '+')).toBe('Option+Drag')
  })
})

describe('input overrides', () => {
  const step = (payload: object, startTime: number, endTime: number) =>
    ({ title: `${INPUT_TITLE_PREFIX}${JSON.stringify(payload)}`, startTime, endTime })

  it('parses mouse and key overrides from marker steps', () => {
    expect(parseInputOverrides([
      step({ mouse: true }, 1000, 2000),
      step({ keys: false }, 3000, 4000),
      step({ mouse: ['left', 'bogus'] }, 5000, 6000),
      { title: 'Click', startTime: 0 },
    ])).toEqual([
      { startMs: 1000, endMs: 2000, mouse: ['left', 'right', 'middle', 'wheel'] },
      { startMs: 3000, endMs: 4000, keys: [] },
      { startMs: 5000, endMs: 6000, mouse: ['left'] },
    ])
  })

  it('lets the innermost override of the kind decide, else the global inputs', () => {
    const inputs = [
      { input: 'left', startMs: 500, endMs: 500 },
      { input: 'left', startMs: 1500, endMs: 1500 },
      { input: 'right', startMs: 2500, endMs: 2500 },
      { input: 'right', startMs: 3500, endMs: 3500 },
    ]
    const overrides = parseInputOverrides([
      step({ mouse: ['left'] }, 1000, 4000),
      step({ mouse: false }, 2000, 3000),
      step({ keys: true }, 3000, 4000),
    ])
    expect(selectInputs(inputs, ['right'], overrides, 'mouse').map((i) => i.startMs)).toEqual([1500])
  })
})

describe('buildMouseInputEvents() / buildKeyOverlayEvents()', () => {
  const toVideo = (t: number) => t - 1000
  const actions = [
    act('mouseDown', 2000, {}, pt),
    act('mouseUp', 3000, {}, pt),
    act('mouseWheel', 4000, { deltaY: 100 }),
    act('keyboardPress', 5000, { key: 'Control+z' }),
    act('keyboardPress', 6000, { key: 'a' }),
    { title: `${INPUT_TITLE_PREFIX}{"keys":["keys"]}`, startTime: 5900, endTime: 6100 },
  ]

  it('keeps the global mouse inputs and maps them to the video', () => {
    const events = buildMouseInputEvents(actions, resolveMouseIndicatorConfig(true), toVideo)
    expect(events).toEqual([{ input: 'wheel', direction: 'down', videoTimeMs: 3005, endTimeMs: 3005, traceMs: 4005, endTraceMs: 4005 }])
    expect(buildMouseInputEvents(actions, resolveMouseIndicatorConfig(undefined), toVideo)).toEqual([])
    expect(buildMouseInputEvents(actions, resolveMouseIndicatorConfig({ inputs: ['left'] }), toVideo).map((e) => e.input)).toEqual(['left'])
  })

  it('labels key presses, with an override showing plain keys', () => {
    expect(buildKeyOverlayEvents(actions, {}, toVideo).map((e) => e.text)).toEqual(['Ctrl + Z', 'A'])
    expect(buildKeyOverlayEvents(actions, { inputs: [], labels: { Control: 'Strg' } }, toVideo).map((e) => e.text)).toEqual(['A'])
  })
})

describe('page.mouse.click()', () => {
  it('shows its button', () => {
    const inputs = collectMouseInputs([act('mouseClick', 1000, { x: 1, y: 1, button: 'right', clickCount: 1 }, pt)])
    expect(inputs).toEqual([{ input: 'right', startMs: 1005, endMs: 1005 }])
  })

  it('names a modifier held over it', () => {
    const inputs = collectKeyInputs([
      act('keyboardDown', 1000, { key: 'Shift' }),
      act('mouseClick', 1100, { x: 1, y: 1 }, pt),
      act('keyboardUp', 1200, { key: 'Shift' }),
    ])
    expect(inputs.map((i) => i.keys)).toEqual([['Shift', 'click']])
  })
})

describe('resolveMouseIndicatorConfig()', () => {
  it('keeps the defaults for options given as undefined', () => {
    const resolved = resolveMouseIndicatorConfig({ size: undefined, inputs: undefined, minShowMs: undefined })
    expect(resolved).toMatchObject({ size: 36, inputs: ['right', 'middle', 'wheel'], minShowMs: 400 })
  })
})
