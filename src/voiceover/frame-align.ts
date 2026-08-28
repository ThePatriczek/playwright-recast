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
 * A non-positive, missing, or NaN frame rate returns the input untouched.
 */
export function alignMsUpToFrame(ms: number, fps: number): number {
  if (!(fps > 0)) return ms
  const per = msPerFrame(fps)
  return Math.ceil(ms / per - 1e-9) * per + 0 // normalize -0 to 0
}

/**
 * Align a freeze so both its start AND its end land on frame boundaries.
 *
 * Pushing the hold's start forward means the video plays that much longer
 * before holding, so the raw hold shrinks by the same amount first — same as
 * before. But a shrunk raw duration is not itself a whole number of frames,
 * and downstream consumers disagree on what to do with the remainder:
 * planVoiceoverFreezes() rounds the hold to whole frames for the video, while
 * shiftForFreezes() shifts clicks and cursor keyframes by the exact
 * millisecond value. Left unresolved, that split lets the video and the
 * overlays drift apart by up to half a frame per freeze, accumulating over a
 * run of freezes — the exact class of bug this module exists to eliminate.
 *
 * So the duration is rounded to the nearest whole frame here too. This means
 * we NO LONGER preserve `atVideoMs + durationMs` exactly — the end can move
 * by up to half a frame in either direction relative to the unaligned input.
 * That is the trade: giving up exact end-position preservation buys a
 * stronger guarantee, that both endpoints sit on frame boundaries and the
 * hold is a whole number of frames, so the video hold, the overlay shift, the
 * audio silence, and the subtitle shift all advance by the identical amount.
 *
 * A hold too short to absorb the start shift clamps at zero rather than going
 * negative; the position still aligns.
 *
 * A non-positive, missing, or NaN frame rate returns the inputs untouched.
 */
export function alignFreezeToFrame(
  atVideoMs: number,
  durationMs: number,
  fps: number,
): { atVideoMs: number; durationMs: number } {
  if (!(fps > 0)) return { atVideoMs, durationMs }
  const per = msPerFrame(fps)
  const aligned = alignMsUpToFrame(atVideoMs, fps)
  const shift = aligned - atVideoMs
  const rawDuration = Math.max(0, durationMs - shift)
  const quantisedDuration = Math.round(rawDuration / per) * per + 0 // normalize -0 to 0
  return { atVideoMs: aligned, durationMs: quantisedDuration }
}

/**
 * Align a hold that lets narration audio finish. Like {@link alignFreezeToFrame}
 * but never rounds *down*: the caption timeline advances by this hold, so a
 * short one leaves captions ahead of the voice and compounds across cues; the
 * surplus is absorbed by the next gap. Non-positive/NaN fps passes through.
 */
export function alignNarrationHold(
  atVideoMs: number,
  durationMs: number,
  fps: number,
): { atVideoMs: number; durationMs: number } {
  if (!(fps > 0)) return { atVideoMs, durationMs }
  return {
    atVideoMs: alignMsUpToFrame(atVideoMs, fps),
    durationMs: alignMsUpToFrame(Math.max(0, durationMs), fps),
  }
}
