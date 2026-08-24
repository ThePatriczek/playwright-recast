import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { planSpeedSegments, probeVideoFps } from '../../../src/render/renderer'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-speed-encode-test-'))
const SRC = path.join(TMP_DIR, 'src.mp4')

const countFrames = (file: string): number =>
  Number(
    execFileSync('ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
    ]).toString().trim(),
  )

describe('speed segment encoding is frame-exact', () => {
  beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true })
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=25:d=20',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', SRC,
    ], { stdio: 'pipe' })
  })

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  })

  it('probes the source frame rate', () => {
    expect(probeVideoFps(SRC)).toBe(25)
  })

  it('encodes each planned segment with exactly the planned frame count', () => {
    // Without -frames:v each of these came out 27 frames instead of 25.
    const fps = probeVideoFps(SRC)
    const plan = planSpeedSegments(
      [0, 2, 4, 6].map((s) => ({ startSec: s, endSec: s + 2, speed: 2 })),
      fps,
    )

    const actual = plan.map((seg, i) => {
      const out = path.join(TMP_DIR, `seg-${i}.mp4`)
      execFileSync('ffmpeg', [
        '-y', '-ss', String(seg.startSec), '-to', String(seg.endSec),
        '-i', SRC,
        '-filter:v', `setpts=PTS/${seg.speed},fps=${fps}`,
        '-frames:v', String(seg.frames),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an', out,
      ], { stdio: 'pipe' })
      return countFrames(out)
    })

    expect(actual).toEqual(plan.map((s) => s.frames))
    expect(actual).toEqual([25, 25, 25, 25])
  })
}, 120_000)
