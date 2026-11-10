import type { KeyOverlayConfig, KeyOverlayInput, MouseIndicatorConfig, MouseIndicatorInput } from '../types/input-overlay.js'

export type ResolvedMouseIndicatorConfig = Required<Omit<MouseIndicatorConfig, 'offset'>> & Pick<MouseIndicatorConfig, 'offset'>

const MOUSE_DEFAULTS: ResolvedMouseIndicatorConfig = {
  inputs: ['right', 'middle', 'wheel'],
  size: 36,
  color: '#FFFFFF',
  outlineColor: '#1F2328',
  accentColor: '#2563EB',
  minShowMs: 400,
}

/**
 * `true` takes the defaults; unset or `false` shows nothing unless a
 * `withMouseIndicator()` step asks for it.
 */
export function resolveMouseIndicatorConfig(config: boolean | MouseIndicatorConfig | undefined): ResolvedMouseIndicatorConfig {
  if (config === true) return MOUSE_DEFAULTS
  if (!config) return { ...MOUSE_DEFAULTS, inputs: [] as MouseIndicatorInput[] }
  return {
    inputs: config.inputs ?? MOUSE_DEFAULTS.inputs,
    size: config.size ?? MOUSE_DEFAULTS.size,
    color: config.color ?? MOUSE_DEFAULTS.color,
    outlineColor: config.outlineColor ?? MOUSE_DEFAULTS.outlineColor,
    accentColor: config.accentColor ?? MOUSE_DEFAULTS.accentColor,
    minShowMs: config.minShowMs ?? MOUSE_DEFAULTS.minShowMs,
    ...(config.offset ? { offset: config.offset } : {}),
  }
}

export const DEFAULT_KEY_INPUTS: KeyOverlayInput[] = ['combos', 'special', 'mouse-modifiers']
