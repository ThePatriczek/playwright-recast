import { execFileSync } from 'node:child_process'

export interface RippleArgs {
  color: string     // hex '#RRGGBB'
  opacity: number   // 0.0-1.0
  radius: number    // px at 1080p
  duration: number  // ms
  outputPath: string
  scaleFactor: number // e.g., 2.0 for 4K source from 1080p-relative
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
 * Build ffmpeg args to generate a transparent ripple clip.
 * Creates a short video with an expanding circle that fades out.
 * Uses geq on a small canvas (2*radius x 2*radius) for performance.
 */
export function buildRippleArgs(opts: RippleArgs): string[] {
  const { r, g, b } = hexToRgb(opts.color)
  const scaledRadius = Math.round(opts.radius * opts.scaleFactor)
  const size = scaledRadius * 2
  const s = size % 2 === 0 ? size : size + 1
  const center = s / 2
  const durSec = (opts.duration / 1000).toFixed(3)
  const alpha = Math.round(opts.opacity * 255)

  // geq alpha expression — commas within expression must be escaped as \, for the
  // filter graph parser. Commas BETWEEN filters (color,format,geq) stay as regular ,.
  // \\, in JS string → \, in the ffmpeg arg → treated as literal comma in expression.
  // Simple approach: static filled circle via geq + fade=out:alpha=1 for animation.
  // Avoids complex nested expressions that break ffmpeg's geq evaluator.
  const e = '\\,' // escaped comma for geq expression args
  const circleExpr = `if(lte(hypot(X-${center}${e}Y-${center})${e}${scaledRadius})${e}${alpha}${e}0)`
  const lavfiInput = `color=c=black@0:s=${s}x${s}:d=${durSec}:r=30,format=rgba,geq=r=${r}:g=${g}:b=${b}:a=${circleExpr},fade=t=out:st=0:d=${durSec}:alpha=1`

  return [
    '-y',
    '-f', 'lavfi', '-i', lavfiInput,
    '-c:v', 'png',
    opts.outputPath,
  ]
}

/**
 * Generate a transparent ripple clip to a temp file.
 */
export function generateRippleClip(opts: RippleArgs): string {
  const args = buildRippleArgs(opts)
  execFileSync('ffmpeg', args, { stdio: 'pipe' })
  return opts.outputPath
}
