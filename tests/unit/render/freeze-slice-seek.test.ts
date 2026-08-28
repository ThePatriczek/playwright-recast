import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * applyVoiceoverFreezes() seeks to each slice with `-ss` instead of letting
 * `trim=start_frame` decode every preceding frame. Without the seek, N slices
 * cost O(N²) decodes: a real 160-slice screencast spent 9 minutes in this
 * stage, and one 31-frame slice near the end took 6.9s.
 *
 * The seek must not move the cut. These cases pin the equivalence the renderer
 * relies on — a half-frame-early `-ss` plus a relative `trim=end_frame` yields
 * byte-identical frames to the absolute `trim=start_frame:end_frame` it
 * replaced, including across keyframe boundaries.
 */

const FPS = 25
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-freeze-seek-test-'))
const SRC = path.join(TMP_DIR, 'src.mp4')

/** Per-frame checksums of a decoded slice, so an off-by-one cut is visible. */
function frameHashes(args: string[]): string[] {
  const out = path.join(TMP_DIR, 'hashes.framemd5')
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', ...args,
    '-an', '-pix_fmt', 'yuv420p', '-f', 'framemd5', out,
  ], { stdio: 'pipe' })
  return fs.readFileSync(out, 'utf8')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(',').pop()!.trim())
}

/** The slicing this replaced: absolute frame indices, full decode from 0. */
function trimOnly(startFrame: number, endFrame: number | null): string[] {
  const trim = endFrame !== null
    ? `trim=start_frame=${startFrame}:end_frame=${endFrame}`
    : `trim=start_frame=${startFrame}`
  return frameHashes(['-i', SRC, '-vf', `${trim},setpts=PTS-STARTPTS`])
}

/** The slicing the renderer now emits: seek + frame-counted length. */
function seekAndTrim(startFrame: number, endFrame: number | null): string[] {
  const seekArgs = startFrame > 0
    ? ['-ss', ((startFrame - 0.5) / FPS).toFixed(6)]
    : []
  const filters = endFrame !== null
    ? [`trim=end_frame=${endFrame - startFrame}`, 'setpts=PTS-STARTPTS']
    : ['setpts=PTS-STARTPTS']
  return frameHashes([...seekArgs, '-i', SRC, '-vf', filters.join(',')])
}

describe('freeze slicing seeks without moving the cut', () => {
  beforeAll(() => {
    // testsrc gives every frame distinct content, so a cut that slips by one
    // frame changes the checksums instead of hiding in identical stills.
    // 1000 frames spans several x264 keyframe intervals.
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `testsrc=s=320x240:r=${FPS}:d=40`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', SRC,
    ], { stdio: 'pipe' })
  })

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  })

  it.each([
    // A leading slice has no seek to apply at all.
    { startFrame: 0, endFrame: 1, name: 'single opening frame' },
    { startFrame: 0, endFrame: 37, name: 'from the first frame' },
    // Every keyframe-relative position: the seek decodes from the preceding
    // keyframe, so landing exactly on one, just before, and just after it are
    // the cases where an accurate seek could round to the wrong frame.
    { startFrame: 249, endFrame: 260, name: 'just before a keyframe' },
    { startFrame: 250, endFrame: 281, name: 'exactly on a keyframe' },
    { startFrame: 251, endFrame: 252, name: 'just after a keyframe' },
    { startFrame: 613, endFrame: 681, name: 'mid-GOP' },
    { startFrame: 999, endFrame: 1000, name: 'final frame' },
  ])('matches trim-only slicing $name', ({ startFrame, endFrame }) => {
    const expected = trimOnly(startFrame, endFrame)
    expect(expected).toHaveLength(endFrame - startFrame)
    expect(seekAndTrim(startFrame, endFrame)).toEqual(expected)
  })

  it('matches trim-only slicing for an open-ended tail slice', () => {
    const expected = trimOnly(940, null)
    expect(expected).toHaveLength(60)
    expect(seekAndTrim(940, null)).toEqual(expected)
  })

  it('reassembles the whole video when contiguous slices are concatenated', () => {
    // The renderer concatenates the slices back together, so the cuts must
    // partition the frames with no gap, overlap, or duplicated boundary frame.
    const cuts = [0, 1, 249, 250, 251, 613, 940, 1000]
    const sliced = cuts.slice(0, -1).flatMap((start, i) =>
      seekAndTrim(start, cuts[i + 1]!),
    )
    expect(sliced).toEqual(trimOnly(0, 1000))
  })
}, 180_000)
