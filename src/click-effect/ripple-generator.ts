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

  // geq alpha expression:
  // - expanding circle: radius grows linearly from 0 to max
  // - fading: overall opacity decreases over time
  // - soft edge: 3px gradient at circle boundary
  const alphaExpr = [
    `if(lte(hypot(X-${center}\\,Y-${center})`,
    `\\,${scaledRadius}*(t/${durSec}))`,
    `\\,${alpha}*(1-t/${durSec})*max(0\\,1-max(0\\,hypot(X-${center}\\,Y-${center})-${scaledRadius}*(t/${durSec})+3)/3)`,
    `\\,0)`,
  ].join('')

  const lavfiInput = `color=c=black@0:s=${s}x${s}:d=${durSec}:r=30,format=rgba,geq=r=${r}:g=${g}:b=${b}:a='${alphaExpr}'`

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
