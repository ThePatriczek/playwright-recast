import type { TextHighlightConfig, HighlightEvent } from '../types/text-highlight.js'

export const DEFAULT_TEXT_HIGHLIGHT = {
  color: '#FFEB3B',
  opacity: 0.35,
  duration: 2000,
  fadeOut: 0,
  swipeDuration: 300,
  paddingX: 4,
  paddingY: 2,
} as const

export type ResolvedTextHighlightConfig = Required<
  Pick<TextHighlightConfig, 'color' | 'opacity' | 'duration' | 'fadeOut' | 'swipeDuration'>
> & { padding: { x: number; y: number } } & TextHighlightConfig

/** Merge user config with defaults */
export function resolveTextHighlightConfig(
  config: TextHighlightConfig,
): ResolvedTextHighlightConfig {
  return {
    ...config,
    color: config.color ?? DEFAULT_TEXT_HIGHLIGHT.color,
    opacity: config.opacity ?? DEFAULT_TEXT_HIGHLIGHT.opacity,
    duration: config.duration ?? DEFAULT_TEXT_HIGHLIGHT.duration,
    fadeOut: config.fadeOut ?? DEFAULT_TEXT_HIGHLIGHT.fadeOut,
    swipeDuration: config.swipeDuration ?? DEFAULT_TEXT_HIGHLIGHT.swipeDuration,
    padding: {
      x: config.padding?.x ?? DEFAULT_TEXT_HIGHLIGHT.paddingX,
      y: config.padding?.y ?? DEFAULT_TEXT_HIGHLIGHT.paddingY,
    },
  }
}
