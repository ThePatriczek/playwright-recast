import { execFileSync } from 'node:child_process'

export interface HighlightClipArgs {
  /** Highlight color as hex '#RRGGBB' */
  color: string
  /** Opacity 0.0–1.0 */
  opacity: number
  /** Width of the highlight rectangle in pixels (already scaled) */
  width: number
  /** Height of the highlight rectangle in pixels (already scaled) */
  height: number
  /** Swipe animation duration in ms */
  swipeDuration: number
  /** Total visibility duration in ms (before fade out starts) */
  duration: number
  /** Fade out duration in ms */
  fadeOut: number
  /** Output file path */
  outputPath: string
}

/** Parse hex color to RGB components */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  }
}

/**
 * Build ffmpeg args to generate a transparent highlight marker clip.
 *
 * Animation profile:
 * 1. Swipe: rectangle reveals left-to-right (crop width grows)
 * 2. Hold: full rectangle visible
 * 3. Fade out: alpha fades to 0
 *
 * Uses a solid color source with crop for swipe animation and fade for exit.
 */
export function buildHighlightArgs(opts: HighlightClipArgs): string[] {
  const { r, g, b } = hexToRgb(opts.color)
  const w = opts.width % 2 === 0 ? opts.width : opts.width + 1
  const h = opts.height % 2 === 0 ? opts.height : opts.height + 1
  const alpha = Math.round(opts.opacity * 255)

  const totalDurMs = opts.duration + opts.fadeOut
  const totalDurSec = (totalDurMs / 1000).toFixed(3)
  const swipeSec = (opts.swipeDuration / 1000).toFixed(3)
  const fadeStartSec = (opts.duration / 1000).toFixed(3)
  const fadeOutSec = (opts.fadeOut / 1000).toFixed(3)

  // Generate a solid RGBA rectangle with swipe-in animation via geq + fade-out.
  //
  // The geq filter renders the colored rectangle AND handles the swipe reveal in one pass.
  // Alpha expression: pixels with X beyond the swipe frontier are transparent (alpha=0).
  // The swipe frontier moves from X=0 to X=W over swipeDuration.
  // After swipeDuration, all pixels are fully visible (alpha=configured value).
  // The fade filter then handles the exit animation.
  //
  // geq alpha expression: if(lte(X, W * min(1, T/swipeSec)), alpha, 0)
  // - at t=0: frontier at X=0, all transparent
  // - at t=swipeSec: frontier at X=W, all visible
  // - after: clamped to full width
  //
  // Note: \\, in JS string → \, in ffmpeg arg → escaped comma inside geq expression
  // (same pattern as ripple-generator.ts)
  const e = '\\,' // escaped comma for geq expression args
  const swipeAlpha = `if(lte(X${e}${w}*min(1${e}T/${swipeSec}))${e}${alpha}${e}0)`
  const lavfiInput = [
    `color=c=black@0:s=${w}x${h}:d=${totalDurSec}:r=30`,
    `format=rgba`,
    `geq=r=${r}:g=${g}:b=${b}:a=${swipeAlpha}`,
    `fade=t=out:st=${fadeStartSec}:d=${fadeOutSec}:alpha=1`,
  ].join(',')

  return [
    '-y',
    '-f', 'lavfi', '-i', lavfiInput,
    '-c:v', 'png',
    opts.outputPath,
  ]
}

/**
 * Generate a transparent highlight marker clip to a temp file.
 */
export function generateHighlightClip(opts: HighlightClipArgs): string {
  const args = buildHighlightArgs(opts)
  execFileSync('ffmpeg', args, { stdio: 'pipe' })
  return opts.outputPath
}
