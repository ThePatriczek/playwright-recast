import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  assembleVideoFromScreencastFrames,
  selectRecordingPageFrames,
} from '../../../src/render/screencast-assembler'
import type { ScreencastFrame } from '../../../src/types/trace'
import { toMonotonic } from '../../../src/types/trace'

const TMP_DIR = path.join('/tmp', 'recast-screencast-test')

function makeJpeg(label: string, color: string): Buffer {
  const filePath = path.join(TMP_DIR, `seed-${label}.jpg`)
  execFileSync(
    'ffmpeg',
    [
      '-y', '-f', 'lavfi',
      '-i', `color=c=${color}:s=320x240:d=0.1`,
      '-frames:v', '1', '-q:v', '5', filePath,
    ],
    { stdio: 'pipe' },
  )
  const buf = fs.readFileSync(filePath)
  fs.unlinkSync(filePath)
  return buf
}

function ffprobe(field: string, file: string): string {
  return execFileSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', `stream=${field}`,
      '-of', 'default=nw=1:nk=1',
      file,
    ],
    { encoding: 'utf-8' },
  ).trim()
}

function durationSec(file: string): number {
  const out = execFileSync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ],
    { encoding: 'utf-8' },
  ).trim()
  return Number(out)
}

describe('screencast assembler', () => {
  beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true })
  })

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  })

  it('produces a CFR 25fps mp4 covering the screencast time span', async () => {
    const sha = ['aaa', 'bbb', 'ccc']
    const jpegs: Record<string, Buffer> = {
      aaa: makeJpeg('red', 'red'),
      bbb: makeJpeg('green', 'green'),
      ccc: makeJpeg('blue', 'blue'),
    }
    const frames: ScreencastFrame[] = [
      { sha1: sha[0]!, timestamp: toMonotonic(0), pageId: 'p1', width: 320, height: 240 },
      { sha1: sha[1]!, timestamp: toMonotonic(500), pageId: 'p1', width: 320, height: 240 },
      { sha1: sha[2]!, timestamp: toMonotonic(1500), pageId: 'p1', width: 320, height: 240 },
    ]
    const outputPath = path.join(TMP_DIR, 'assembled.mp4')

    await assembleVideoFromScreencastFrames({
      frames,
      readFrame: (s) => Promise.resolve(jpegs[s]!),
      tmpDir: path.join(TMP_DIR, 'work'),
      outputPath,
    })

    expect(fs.existsSync(outputPath)).toBe(true)
    expect(ffprobe('r_frame_rate', outputPath)).toBe('25/1')
    expect(ffprobe('pix_fmt', outputPath)).toBe('yuv420p')
    // Span is 0→1500ms + tail 40ms ≈ 1.54s
    const dur = durationSec(outputPath)
    expect(dur).toBeGreaterThan(1.4)
    expect(dur).toBeLessThan(1.8)
  })

  it('rejects empty frame list with a clear error', async () => {
    await expect(
      assembleVideoFromScreencastFrames({
        frames: [],
        readFrame: () => Promise.resolve(Buffer.alloc(0)),
        tmpDir: path.join(TMP_DIR, 'empty'),
        outputPath: path.join(TMP_DIR, 'empty.mp4'),
      }),
    ).rejects.toThrow(/no screencast frames/i)
  })
})

describe('selectRecordingPageFrames', () => {
  it('returns the frames belonging to the page whose last frame appears latest', () => {
    const frames: ScreencastFrame[] = [
      { sha1: '1', timestamp: toMonotonic(0), pageId: 'a', width: 1, height: 1 },
      { sha1: '2', timestamp: toMonotonic(50), pageId: 'b', width: 1, height: 1 },
      { sha1: '3', timestamp: toMonotonic(100), pageId: 'a', width: 1, height: 1 },
      { sha1: '4', timestamp: toMonotonic(200), pageId: 'b', width: 1, height: 1 },
    ]
    const picked = selectRecordingPageFrames(frames)
    expect(picked.map((f) => f.sha1)).toEqual(['2', '4'])
  })

  it('returns the input unchanged when frames lack pageId', () => {
    const frames: ScreencastFrame[] = [
      { sha1: '1', timestamp: toMonotonic(0), width: 1, height: 1 },
      { sha1: '2', timestamp: toMonotonic(50), width: 1, height: 1 },
    ]
    expect(selectRecordingPageFrames(frames)).toBe(frames)
  })

  it('returns empty for empty input', () => {
    expect(selectRecordingPageFrames([])).toEqual([])
  })
})
