import type { PlaywrightTestConfig } from '@playwright/test'

export interface RecastVideoOptions {
  /** Layout size in CSS pixels - what the page sees as its window. */
  viewport: { width: number; height: number }
  /**
   * Device pixels per CSS pixel in the recording, at least 1; decimals work.
   * Pixel-sharp while `scale x viewport >= output x zoom` on both axes, so pick
   * `max(1, max zoom x max(output width / viewport width, output height /
   * viewport height))` (2.4 for 1.8x at 1440p from 1920x1080). Costs grow
   * with the pixels (scale²), the render less than that: 2 -> 2.4 is 44% more
   * pixels and rendered 25% slower in one measurement.
   * Default 2.
   */
  scale?: number
}

/** Concrete, so `launchOptions.args` can be merged without casts. */
export interface RecastVideoUse {
  viewport: { width: number; height: number }
  deviceScaleFactor: number
  headless: true
  launchOptions: { args: string[] }
  video: { mode: 'on'; size: { width: number; height: number } }
}

/**
 * Playwright `use` options that record the video at `viewport x scale` device
 * pixels, so zoomed-in text stays sharp. Chromium only.
 *
 * Three settings have to agree, and each fails silently on its own:
 * - `deviceScaleFactor` alone does not reach the video - headless Chromium
 *   screencasts at CSS size; `--force-device-scale-factor` does.
 * - `video.size` must be `viewport x scale`: Playwright pads a smaller frame
 *   with gray instead of scaling it.
 * - Headed Chromium follows the OS display scale instead, so frame sizes
 *   depend on the machine. Recording is headless.
 *
 * Spread it into `use` and merge your own `launchOptions.args` into the
 * returned ones rather than replacing them.
 *
 * ```ts
 * use: { ...recastVideo({ viewport: { width: 1920, height: 1080 } }), trace: 'on' }
 * ```
 */
export function recastVideo(options: RecastVideoOptions): RecastVideoUse {
  const scale = options.scale ?? 2
  if (!Number.isFinite(scale) || scale < 1) {
    throw new Error(`recastVideo: scale must be a number >= 1, got ${scale}`)
  }
  const { width, height } = options.viewport
  return {
    viewport: { width, height },
    deviceScaleFactor: scale,
    headless: true,
    launchOptions: { args: [`--force-device-scale-factor=${scale}`] },
    // Chromium rounds a decimal scale's frame to whole pixels; the video must match.
    video: { mode: 'on', size: { width: Math.round(width * scale), height: Math.round(height * scale) } },
  } satisfies NonNullable<PlaywrightTestConfig['use']>
}
