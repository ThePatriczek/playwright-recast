import type { PlaywrightTestConfig } from '@playwright/test'

export interface RecastVideoOptions {
  /** Layout size in CSS pixels - what the page sees as its window. */
  viewport: { width: number; height: number }
  /**
   * Device pixels per CSS pixel in the recording, at least 1; decimals work.
   * Rounded up to the next scale that gives whole, even device pixels, by at
   * most 2 / gcd(width, height): 1.3334 records at 1.35 for 1920x1080.
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

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/**
 * The smallest scale >= `scale` at which the viewport is whole, even device
 * pixels on both axes, i.e. a multiple of 2 / gcd(width, height). Only those
 * record exactly: VP8 (4:2:0) takes even sizes only, and any other size makes
 * Playwright pad Chromium's frame gray or rescale it.
 */
function exactScale({ width, height }: { width: number; height: number }, scale: number): number {
  const g = gcd(width, height)
  return (2 * Math.ceil((scale * g) / 2 - 1e-9)) / g
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
  const requested = options.scale ?? 2
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error(`recastVideo: scale must be a number >= 1, got ${requested}`)
  }
  const { width, height } = options.viewport
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`recastVideo: viewport must be positive, whole CSS pixels, got ${width}x${height}`)
  }
  const scale = exactScale(options.viewport, requested)
  const size = { width: Math.round(width * scale), height: Math.round(height * scale) }
  return {
    viewport: { width, height },
    deviceScaleFactor: scale,
    headless: true,
    launchOptions: { args: [`--force-device-scale-factor=${scale}`] },
    video: { mode: 'on', size },
  } satisfies NonNullable<PlaywrightTestConfig['use']>
}
