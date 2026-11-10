import { INPUT_TITLE_PREFIX } from '../helpers.js'
import type { KeyOverlayInput, MouseIndicatorInput, WheelDirection } from '../types/input-overlay.js'

/** A trace action as the input collectors read it. */
export interface InputAction {
  method?: string
  params?: Record<string, unknown>
  title?: unknown
  point?: { x: number; y: number }
  startTime: number
  endTime?: number
}

/** An input in trace time: from its press to its release. */
export interface TimedInput {
  startMs: number
  endMs: number
}

export interface MouseInput extends TimedInput {
  input: MouseIndicatorInput
  direction?: WheelDirection
}

export interface KeyInput extends TimedInput {
  /** Key names, modifiers first, e.g. `['Control', 'z']` or `['Alt', 'drag']` */
  keys: string[]
  input: KeyOverlayInput
}

export const ALL_MOUSE_INPUTS: MouseIndicatorInput[] = ['left', 'right', 'middle', 'wheel']
export const ALL_KEY_INPUTS: KeyOverlayInput[] = ['combos', 'special', 'mouse-modifiers', 'keys']

const end = (a: InputAction): number => a.endTime ?? a.startTime
const byStart = (actions: ReadonlyArray<InputAction>): InputAction[] =>
  [...actions].sort((a, b) => a.startTime - b.startTime)
const buttonOf = (a: InputAction): MouseIndicatorInput => {
  const b = a.params?.button
  return b === 'right' || b === 'middle' ? b : 'left'
}
/** `locator.click()` / `dblclick()`, and `page.mouse.click()` / `dblclick()` (one `mouseClick`) */
const CLICKS = new Set(['click', 'dblclick', 'mouseClick'])

function wheelDirection(params: Record<string, unknown> | undefined): WheelDirection | undefined {
  const dx = Number(params?.deltaX ?? 0)
  const dy = Number(params?.deltaY ?? 0)
  if (dy !== 0) return dy < 0 ? 'up' : 'down'
  if (dx !== 0) return dx < 0 ? 'left' : 'right'
  return undefined
}

/** Button presses (down to up, or a click) and wheel turns, in trace time. */
export function collectMouseInputs(actions: ReadonlyArray<InputAction>): MouseInput[] {
  const inputs: MouseInput[] = []
  const down = new Map<MouseIndicatorInput, number>()
  for (const a of byStart(actions)) {
    if (a.method === 'mouseDown') {
      down.set(buttonOf(a), end(a))
    } else if (a.method === 'mouseUp') {
      const button = buttonOf(a)
      const start = down.get(button)
      down.delete(button)
      inputs.push({ input: button, startMs: start ?? end(a), endMs: end(a) })
    } else if (a.method && CLICKS.has(a.method) && a.point) {
      inputs.push({ input: buttonOf(a), startMs: end(a), endMs: end(a) })
    } else if (a.method === 'mouseWheel') {
      const direction = wheelDirection(a.params)
      if (direction) inputs.push({ input: 'wheel', direction, startMs: end(a), endMs: end(a) })
    }
  }
  for (const [input, start] of down) inputs.push({ input, startMs: start, endMs: start })
  return inputs.sort((a, b) => a.startMs - b.startMs)
}

const MODIFIERS = ['Control', 'ControlOrMeta', 'Alt', 'Shift', 'Meta']
const isModifier = (key: string): boolean => MODIFIERS.includes(key)
/** `KeyA` and `Digit1` name a character, like `a` and `1` do. */
const isNamed = (key: string): boolean => key.length > 1 && !/^(Key[A-Z]|Digit\d)$/.test(key)
const byModifierOrder = (a: string, b: string): number => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b)

/** `'Control+Shift+Z'` to its keys; `'+'` and `'Shift++'` keep their plus. */
function splitCombo(combo: string): string[] {
  const parts = combo.split('+')
  const keys: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i < parts.length - 1) {
      keys.push('+')
      i++
    } else if (parts[i] !== '') keys.push(parts[i]!)
  }
  return keys
}

function category(modifiers: string[], key: string): KeyOverlayInput {
  if (modifiers.some((m) => m !== 'Shift')) return 'combos'
  if (isNamed(key)) return modifiers.length > 0 ? 'combos' : 'special'
  return 'keys'
}

type MouseUse = 'click' | 'drag' | 'wheel'

/**
 * Key presses in trace time, each with the modifiers held for it, and
 * modifiers held over a mouse action (`Alt` + `drag`).
 */
export function collectKeyInputs(actions: ReadonlyArray<InputAction>): KeyInput[] {
  const inputs: KeyInput[] = []
  const held = new Map<string, { startMs: number; uses: Set<MouseUse> }>()
  const keyDown = new Map<string, number>()
  let pressing = false
  let dragged = false
  const use = (u: MouseUse): void => { for (const h of held.values()) h.uses.add(u) }
  const press = (combo: string[], startMs: number, endMs: number): void => {
    const key = combo[combo.length - 1]!
    const modifiers = [...new Set([...held.keys(), ...combo.slice(0, -1)])].filter((m) => m !== key).sort(byModifierOrder)
    inputs.push({ keys: [...modifiers, key], input: category(modifiers, key), startMs, endMs })
  }

  for (const a of byStart(actions)) {
    const key = typeof a.params?.key === 'string' ? a.params.key : undefined
    switch (a.method) {
      case 'keyboardPress':
      case 'press':
        if (key) press(splitCombo(key), end(a), end(a))
        break
      case 'keyboardDown':
        if (key && isModifier(key)) held.set(key, { startMs: end(a), uses: new Set() })
        else if (key) keyDown.set(key, end(a))
        break
      case 'keyboardUp': {
        if (!key) break
        const h = held.get(key)
        held.delete(key)
        if (h && h.uses.size > 0) {
          const word: MouseUse = h.uses.has('drag') ? 'drag' : h.uses.has('click') ? 'click' : 'wheel'
          inputs.push({ keys: [key, word], input: 'mouse-modifiers', startMs: h.startMs, endMs: end(a) })
        }
        const downAt = keyDown.get(key)
        keyDown.delete(key)
        if (downAt !== undefined) press([key], downAt, end(a))
        break
      }
      case 'mouseDown':
        pressing = true
        dragged = false
        break
      case 'mouseMove':
        if (pressing) { dragged = true; use('drag') }
        break
      case 'mouseUp':
        if (pressing && !dragged) use('click')
        pressing = false
        break
      case 'mouseWheel':
        use('wheel')
        break
      default:
        if (a.method && CLICKS.has(a.method) && a.point) {
          use('click')
          const mods = Array.isArray(a.params?.modifiers) ? (a.params.modifiers as unknown[]).filter((m): m is string => typeof m === 'string') : []
          const fresh = mods.filter((m) => !held.has(m)).sort(byModifierOrder)
          if (fresh.length > 0) inputs.push({ keys: [...fresh, 'click'], input: 'mouse-modifiers', startMs: end(a), endMs: end(a) })
        }
    }
  }
  return inputs.sort((a, b) => a.startMs - b.startMs)
}

const DEFAULT_LABELS: Record<string, string> = {
  Control: 'Ctrl', ControlOrMeta: 'Ctrl', Escape: 'Esc', Delete: 'Del', ' ': 'Space',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PgUp', PageDown: 'PgDn',
}

/** Display text for a key input, e.g. `Ctrl + Z`. */
export function keyLabel(keys: string[], labels: Record<string, string> = {}, separator = ' + '): string {
  return keys.map((k) => {
    const name = /^Key([A-Z])$|^Digit(\d)$/.exec(k)?.slice(1).find(Boolean) ?? k
    return labels[k] ?? DEFAULT_LABELS[k] ?? (name.length === 1 ? name.toUpperCase() : name)
  }).join(separator)
}

/** A `withMouseIndicator()` / `withKeyOverlay()` range: what shows inside it. */
export interface InputOverride extends TimedInput {
  mouse?: MouseIndicatorInput[]
  keys?: KeyOverlayInput[]
}

function overrideList<T extends string>(value: unknown, all: T[]): T[] | undefined {
  if (value === true) return all
  if (value === false) return []
  if (Array.isArray(value)) return value.filter((v): v is T => all.includes(v as T))
  return undefined
}

/** Parse the override steps the helpers write, in trace time. */
export function parseInputOverrides(actions: ReadonlyArray<InputAction>): InputOverride[] {
  const overrides: InputOverride[] = []
  for (const a of actions) {
    if (typeof a.title !== 'string' || !a.title.startsWith(INPUT_TITLE_PREFIX)) continue
    try {
      const data = JSON.parse(a.title.slice(INPUT_TITLE_PREFIX.length)) as { mouse?: unknown; keys?: unknown }
      const mouse = overrideList(data.mouse, ALL_MOUSE_INPUTS)
      const keys = overrideList(data.keys, ALL_KEY_INPUTS)
      overrides.push({ startMs: a.startTime, endMs: end(a), ...(mouse ? { mouse } : {}), ...(keys ? { keys } : {}) })
    } catch {
      // skip malformed markers
    }
  }
  return overrides
}

/**
 * Keep the inputs that show: the innermost override around an input's start
 * decides, else `global`.
 */
export function selectInputs<I extends TimedInput & { input: string }>(
  inputs: I[],
  global: ReadonlyArray<string>,
  overrides: ReadonlyArray<InputOverride>,
  kind: 'mouse' | 'keys',
): I[] {
  return inputs.filter((input) => {
    const around = overrides
      .filter((o) => o[kind] && o.startMs <= input.startMs && input.startMs <= o.endMs)
      .sort((a, b) => b.startMs - a.startMs)[0]
    return (around?.[kind] ?? global).includes(input.input as never)
  })
}
