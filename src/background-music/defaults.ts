import type { BackgroundMusicConfig } from '../types/background-music.js'

export const DEFAULT_BACKGROUND_MUSIC = {
  volume: 0.3,
  ducking: true,
  duckLevel: 0.1,
  duckFadeMs: 500,
  fadeOutMs: 3000,
  loop: true,
} as const

export type ResolvedBackgroundMusicConfig = Required<BackgroundMusicConfig>

/** Merge user config with defaults */
export function resolveBackgroundMusicConfig(
  config: BackgroundMusicConfig,
): ResolvedBackgroundMusicConfig {
  return {
    ...config,
    volume: config.volume ?? DEFAULT_BACKGROUND_MUSIC.volume,
    ducking: config.ducking ?? DEFAULT_BACKGROUND_MUSIC.ducking,
    duckLevel: config.duckLevel ?? DEFAULT_BACKGROUND_MUSIC.duckLevel,
    duckFadeMs: config.duckFadeMs ?? DEFAULT_BACKGROUND_MUSIC.duckFadeMs,
    fadeOutMs: config.fadeOutMs ?? DEFAULT_BACKGROUND_MUSIC.fadeOutMs,
    loop: config.loop ?? DEFAULT_BACKGROUND_MUSIC.loop,
  }
}
