import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { detectBlankLeadIn, planSpeedSegments, probeVideoFps } from '../../../src/render/renderer'
import { resolveBlankLeadInMs, shiftSubtitlesForBlankLead } from '../../../src/pipeline/blank-lead'
import { computeOutputTimes, buildTimeRemap } from '../../../src/speed/time-remap'
import { toMonotonic } from '../../../src/types/trace'
import type { SpeedSegment } from '../../../src/types/speed'
import type { SubtitleEntry } from '../../../src/types/subtitle'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-blank-speed-render-test-'))
const SRC = path.join(TMP_DIR, 'source.mp4')

/**
 * Mean luma (0-255) of the frame at `atSec`.
 *
 * Scales the frame to a single pixel and reads that byte back as raw gray.
 * No log parsing, no stderr capture — ffmpeg's own averaging does the work.
 * Verified on flat fills: 0x303030 → 37, 0xC0C0C0 → 205.
 */
function meanLumaAt(video: string, atSec: number): number {
  const raw = path.join(TMP_DIR, `probe-${atSec.toFixed(3)}.raw`)
  execFileSync('ffmpeg', [
    '-y', '-ss', String(atSec), '-i', video, '-frames:v', '1',
    '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', raw,
  ], { stdio: 'pipe' })
  return fs.readFileSync(raw)[0]!
}

describe('blank lead-in does not desync speed-mapped output (#20)', () => {
  beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true })

    // 3s low-entropy prefix (sampled PNGs under the 15KB blank threshold),
    // then scene A (dark grey), then scene B (light grey). 1920x1080 so the
    // blank threshold behaves as it does in production.
    const parts = [
      ['color=c=0xF8F8F8:s=1920x1080:d=3:r=25', 'prefix.mp4'],
      ['color=c=0x303030:s=1920x1080:d=6:r=25', 'scene-a.mp4'],
      ['color=c=0xC0C0C0:s=1920x1080:d=6:r=25', 'scene-b.mp4'],
    ] as const

    for (const [lavfi, name] of parts) {
      execFileSync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', lavfi,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        path.join(TMP_DIR, name),
      ], { stdio: 'pipe' })
    }

    const concatList = path.join(TMP_DIR, 'concat.txt')
    fs.writeFileSync(concatList, parts.map(([, n]) => `file '${n}'`).join('\n'))
    execFileSync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', SRC,
    ], { stdio: 'pipe' })
  })

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  })

  it('the fixture reproduces the false blank detection', () => {
    // The premise of the bug: a valid low-entropy opening reads as blank.
    expect(detectBlankLeadIn(SRC, TMP_DIR)).toBeGreaterThan(0)
  })

  it('keeps the cue on the post-transition scene under speed mapping', () => {
    const fps = probeVideoFps(SRC)

    // Speed map over the recording: prefix+scene A at 2x, scene B at 1x.
    // Trace time == source video time for this synthetic fixture.
    const segments: SpeedSegment[] = computeOutputTimes([
      { originalStart: toMonotonic(0), originalEnd: toMonotonic(9000), speed: 2, outputStart: 0, outputEnd: 0 },
      { originalStart: toMonotonic(9000), originalEnd: toMonotonic(15000), speed: 1, outputStart: 0, outputEnd: 0 },
    ])
    const remap = buildTimeRemap(segments)

    // A cue that starts exactly at the scene A → scene B transition.
    const cueOutputMs = remap(toMonotonic(9000))
    const subtitles: SubtitleEntry[] = [
      { index: 1, startMs: cueOutputMs, endMs: cueOutputMs + 2000, text: 'scene B' },
    ]

    // The pipeline's blank policy must leave it alone.
    const offsetMs = resolveBlankLeadInMs(segments, () => detectBlankLeadIn(SRC, TMP_DIR))
    expect(offsetMs).toBe(0)
    shiftSubtitlesForBlankLead(subtitles, offsetMs)
    expect(subtitles[0]!.startMs).toBe(cueOutputMs)

    // Render the speed-mapped video the way renderWithSpeed does — no blank
    // trim, frame-exact segments.
    const plan = planSpeedSegments(
      segments.map((s) => ({
        startSec: (s.originalStart as number) / 1000,
        endSec: (s.originalEnd as number) / 1000,
        speed: s.speed,
      })),
      fps,
    )

    const segPaths = plan.map((s, i) => {
      const out = path.join(TMP_DIR, `out-seg-${i}.mp4`)
      execFileSync('ffmpeg', [
        '-y', '-ss', String(s.startSec), '-to', String(s.endSec), '-i', SRC,
        '-filter:v', `setpts=PTS/${s.speed},fps=${fps}`,
        '-frames:v', String(s.frames),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an', out,
      ], { stdio: 'pipe' })
      return out
    })

    const list = path.join(TMP_DIR, 'out-concat.txt')
    fs.writeFileSync(list, segPaths.map((p) => `file '${path.basename(p)}'`).join('\n'))
    const rendered = path.join(TMP_DIR, 'rendered.mp4')
    execFileSync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', rendered,
    ], { stdio: 'pipe' })

    // The frame at the cue must be scene B (light, YAVG well above scene A's).
    const atCue = meanLumaAt(rendered, cueOutputMs / 1000 + 0.1)
    const beforeCue = meanLumaAt(rendered, cueOutputMs / 1000 - 0.5)

    expect(atCue).toBeGreaterThan(150) // scene B ≈ 0xC0
    expect(beforeCue).toBeLessThan(80) // scene A ≈ 0x30
  })
}, 180_000)
