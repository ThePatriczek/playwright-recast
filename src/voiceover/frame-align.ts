/**
 * Frame-alignment arithmetic for voiceover freezes.
 *
 * Freeze points are born in continuous milliseconds but are ultimately
 * realised as whole video frames. Rounding them at render time would be too
 * late: the same freeze list also drives the audio silence, the subtitle
 * shift, and shiftForFreezes() for clicks and cursor keyframes. Aligning here,
 * once, keeps every consumer on the same numbers.
 */

/** Milliseconds occupied by one frame at `fps`. */
export function msPerFrame(fps: number): number {
  return 1000 / fps
}

/**
 * Round `ms` up to the next whole frame boundary. Values already on a boundary
 * are returned unchanged; the result is never earlier than the input.
 * A non-positive `fps` returns the input untouched.
 */
export function alignMsUpToFrame(ms: number, fps: number): number {
  if (fps <= 0) return ms
  const per = msPerFrame(fps)
  return Math.ceil(ms / per - 1e-9) * per + 0 // normalize -0 to 0
}

/**
 * Align a freeze onto a frame boundary without losing time.
 *
 * Pushing the hold's start forward means the video plays that much longer
 * before holding, so the hold shrinks by the same amount and the freeze's END
 * position is preserved. That end position is what every later cue is measured
 * from — moving it would shift the rest of the video.
 *
 * A hold too short to absorb the shift clamps at zero rather than going
 * negative; the position still aligns.
 */
export function alignFreezeToFrame(
  atVideoMs: number,
  durationMs: number,
  fps: number,
): { atVideoMs: number; durationMs: number } {
  if (fps <= 0) return { atVideoMs, durationMs }
  const aligned = alignMsUpToFrame(atVideoMs, fps)
  const shift = aligned - atVideoMs
  return { atVideoMs: aligned, durationMs: Math.max(0, durationMs - shift) }
}
