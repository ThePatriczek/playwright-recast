/** minterpolate mi_mode — frame generation strategy */
export type InterpolateMode = 'dup' | 'blend' | 'mci'

/** Quality preset — maps to ffmpeg minterpolate parameters */
export type InterpolateQuality = 'fast' | 'balanced' | 'quality'

/** Configuration for the .interpolate() pipeline stage */
export interface InterpolateConfig {
  /** Target frames per second (default: 60) */
  fps?: number
  /** Interpolation mode: 'dup' (duplicate), 'blend' (crossfade), 'mci' (motion-compensated). Default: 'mci' */
  mode?: InterpolateMode
  /** Quality preset for motion compensation parameters. Default: 'balanced' */
  quality?: InterpolateQuality
  /** Number of interpolation passes. Multiple passes produce smoother results by
   *  interpolating already-smoothed frames. FPS is distributed geometrically across passes.
   *  Default: 1 */
  passes?: number
}
