/**
 * How much the render enlarges source pixels at its tightest zoom: the
 * output size at `maxZoom`, divided by the source size, on the tighter axis.
 * Above 1 the output is upscaled and text goes soft.
 */
export function upscaleFactor(
  source: { width: number; height: number },
  target: { width: number; height: number },
  maxZoom: number,
): number {
  return Math.max(
    (target.width * maxZoom) / source.width,
    (target.height * maxZoom) / source.height,
  )
}

/**
 * A warning once the upscale is visible, or null. Up to 1.25x text still
 * looks crisp, up to 1.5x slightly soft, beyond that soft.
 */
export function upscaleWarning(
  source: { width: number; height: number },
  target: { width: number; height: number },
  maxZoom: number,
): string | null {
  const factor = upscaleFactor(source, target, maxZoom)
  if (factor <= 1.25) return null
  const effect = factor <= 1.5 ? 'slightly soft' : 'soft'
  // The recording scales uniformly, so grow the source by the factor, not the target by the zoom.
  const needed = `${Math.ceil(source.width * factor)}x${Math.ceil(source.height * factor)}`
  return `Source ${source.width}x${source.height} is upscaled ${factor.toFixed(2)}x ` +
    `for ${target.width}x${target.height} at zoom ${maxZoom}; text will be ${effect}. ` +
    `Record at ${needed} or more, e.g. with a higher scale in recastVideo() from 'playwright-recast/config'.`
}
