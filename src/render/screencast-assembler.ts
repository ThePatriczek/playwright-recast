import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ScreencastFrame } from '../types/trace.js'

const DEFAULT_TAIL_DURATION_SEC = 0.04
const OUTPUT_FPS = 25

export interface AssembleOptions {
  frames: readonly ScreencastFrame[]
  readFrame: (sha1: string) => Promise<Buffer>
  tmpDir: string
  outputPath: string
}

/**
 * Assemble a video from Playwright screencast JPEG frames using ffmpeg's
 * concat demuxer with per-frame durations. Used as a fallback when a trace
 * has no sibling .webm video — keeps the rest of the render pipeline working
 * against a single source file. The resulting video has variable frame rate
 * matching the original screencast cadence.
 */
export async function assembleVideoFromScreencastFrames(opts: AssembleOptions): Promise<void> {
  const { frames, readFrame, tmpDir, outputPath } = opts
  if (frames.length === 0) {
    throw new Error('Cannot assemble video: no screencast frames available')
  }
  fs.mkdirSync(tmpDir, { recursive: true })

  const framePaths: string[] = []
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!
    const data = await readFrame(frame.sha1)
    const filePath = path.join(tmpDir, `frame-${i.toString().padStart(6, '0')}.jpg`)
    fs.writeFileSync(filePath, data)
    framePaths.push(filePath)
  }

  // ffmpeg concat demuxer requires the final `file` directive to be repeated
  // so the duration declared for the last "real" entry actually takes effect.
  const lines: string[] = ['ffconcat version 1.0']
  for (let i = 0; i < frames.length - 1; i++) {
    const cur = frames[i]!
    const next = frames[i + 1]!
    const duration = Math.max(0.001, ((next.timestamp as number) - (cur.timestamp as number)) / 1000)
    lines.push(`file '${path.basename(framePaths[i]!)}'`)
    lines.push(`duration ${duration.toFixed(6)}`)
  }
  const lastIdx = frames.length - 1
  lines.push(`file '${path.basename(framePaths[lastIdx]!)}'`)
  lines.push(`duration ${DEFAULT_TAIL_DURATION_SEC.toFixed(6)}`)
  lines.push(`file '${path.basename(framePaths[lastIdx]!)}'`)

  const concatPath = path.join(tmpDir, 'screencast-concat.txt')
  fs.writeFileSync(concatPath, lines.join('\n') + '\n')

  // Force CFR 25fps so downstream filters (zoom, overlay, speed) see a stable
  // frame rate. The `fps` filter duplicates frames during idle pauses and
  // drops during bursts — preserving the visual cadence of the screencast.
  // 25fps matches Playwright's recordVideo default.
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', concatPath,
    // JPEG inputs come in yuvj420p (full range). Explicit `scale` with
    // range conversion is the only reliable way to land at standard
    // limited-range yuv420p — bare `format=yuv420p` keeps the full range.
    '-vf', `fps=${OUTPUT_FPS},scale=ceil(iw/2)*2:ceil(ih/2)*2:in_range=full:out_range=tv,format=yuv420p`,
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-r', String(OUTPUT_FPS),
    outputPath,
  ], { stdio: 'pipe' })
}

/**
 * Pick the screencast frames that belong to the recording page. The
 * recording page is the one whose last frame appears latest — same heuristic
 * the renderer uses to align timing. Multi-tab traces with parallel
 * framesets are collapsed to the dominant page so the assembled video
 * matches a single continuous viewport.
 */
export function selectRecordingPageFrames(
  frames: readonly ScreencastFrame[],
): readonly ScreencastFrame[] {
  if (frames.length === 0) return frames
  const recordingPageId = frames[frames.length - 1]!.pageId
  if (recordingPageId === undefined) return frames
  return frames.filter((f) => f.pageId === recordingPageId)
}
