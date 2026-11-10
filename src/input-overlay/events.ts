import type { KeyOverlayConfig, KeyOverlayEvent, MouseInputEvent } from '../types/input-overlay.js'
import { DEFAULT_KEY_INPUTS, type ResolvedMouseIndicatorConfig } from './defaults.js'
import {
  collectKeyInputs, collectMouseInputs, keyLabel, parseInputOverrides, selectInputs, type InputAction,
} from './inputs.js'

const timing = (startMs: number, endMs: number, toVideoMs: (t: number) => number) => ({
  videoTimeMs: Math.max(0, Math.round(toVideoMs(startMs))),
  endTimeMs: Math.max(0, Math.round(toVideoMs(endMs))),
  traceMs: startMs,
  endTraceMs: endMs,
})

/** The mouse inputs the indicator shows, on the output video. */
export function buildMouseInputEvents(
  actions: ReadonlyArray<InputAction>,
  config: ResolvedMouseIndicatorConfig,
  toVideoMs: (traceMs: number) => number,
): MouseInputEvent[] {
  const shown = selectInputs(collectMouseInputs(actions), config.inputs, parseInputOverrides(actions), 'mouse')
  return shown.map((m) => ({
    input: m.input,
    ...(m.direction ? { direction: m.direction } : {}),
    ...timing(m.startMs, m.endMs, toVideoMs),
  }))
}

/** The key presses the key overlay shows, on the output video. */
export function buildKeyOverlayEvents(
  actions: ReadonlyArray<InputAction>,
  config: KeyOverlayConfig,
  toVideoMs: (traceMs: number) => number,
): KeyOverlayEvent[] {
  const shown = selectInputs(collectKeyInputs(actions), config.inputs ?? DEFAULT_KEY_INPUTS, parseInputOverrides(actions), 'keys')
  return shown.map((k) => ({
    text: keyLabel(k.keys, config.labels, config.separator),
    input: k.input,
    ...timing(k.startMs, k.endMs, toVideoMs),
  }))
}
