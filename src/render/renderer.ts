import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { RenderConfig } from '../types/render.js'
import { resolveResolution } from '../types/render.js'
import type { SubtitleEntry } from '../types/subtitle.js'
import type { ParsedTrace } from '../types/trace.js'
import { writeSrt } from '../subtitles/srt-writer.js'

/**
 * Detect blank/white frames at the start of a video and return the timestamp
 * of the first non-blank frame. Blank frames are identified by file size —
 * a solid-color frame compresses to a very small PNG.
 *
 * @returns Seconds to skip at the start, or 0 if no blank frames.
 */
function detectBlankLeadIn(videoPath: string, tmpDir: string): number {
  const probeStep = 0.1 // seconds
  const maxProbe = 3.0 // don't look beyond 3 seconds
  const blankThreshold = 15_000 // bytes — blank 1920x1080 PNG is ~8-10KB

  let lastBlankTime = -1

  for (let t = 0; t <= maxProbe; t += probeStep) {
    const framePath = path.join(tmpDir, `blank-probe-${t.toFixed(1)}.png`)
    try {
      execFileSync('ffmpeg', [
        '-y', '-ss', String(t), '-i', videoPath,
        '-frames:v', '1', framePath,
      ], { stdio: 'pipe' })

      const size = fs.statSync(framePath).size
      fs.unlinkSync(framePath)

      if (size <= blankThreshold) {
        lastBlankTime = t
      } else {
        // First non-blank frame — trim up to this point
        return lastBlankTime >= 0 ? t : 0
      }
    } catch {
      break
    }
  }

  // All probed frames were blank — trim the whole probed range
  return lastBlankTime >= 0 ? lastBlankTime + probeStep : 0
}

/**
 * Trace data the renderer needs. Extends the base ParsedTrace with optional
 * subtitle, voiceover, and source-video fields. The renderer gracefully
 * handles any combination — callers do not need to provide every field.
 */
export interface RenderableTrace extends ParsedTrace {
  sourceVideoPath?: string
  subtitles?: SubtitleEntry[]
  voiceover?: { audioTrackPath: string; entries: unknown[]; totalDurationMs: number }
}

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', args, { stdio: 'pipe' })
}

/**
 * Render with zoom by splitting video into segments:
 * - Non-zoomed segments pass through at full resolution
 * - Zoomed segments get crop + scale to zoom into the target
 *
 * Then all segments are concatenated back together.
 */
function renderWithZoom(
  sourceVideo: string,
  subtitles: SubtitleEntry[],
  width: number,
  height: number,
  tmpDir: string,
): string {
  // Build time segments: alternating between no-zoom and zoom
  type Segment = { startSec: number; endSec: number; zoom?: SubtitleEntry['zoom'] }
  const segments: Segment[] = []

  // Get video duration
  const durationStr = execFileSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', sourceVideo,
  ]).toString().trim()
  const videoDuration = Number(durationStr)

  const zoomSubs = subtitles.filter((s) => s.zoom && s.zoom.level > 1.0)
  let cursor = 0

  for (const sub of zoomSubs) {
    const startSec = sub.startMs / 1000
    const endSec = sub.endMs / 1000

    // Gap before this zoom
    if (startSec > cursor + 0.1) {
      segments.push({ startSec: cursor, endSec: startSec })
    }
    // Zoomed segment
    segments.push({ startSec, endSec, zoom: sub.zoom })
    cursor = endSec
  }
  // Remaining after last zoom
  if (cursor < videoDuration - 0.1) {
    segments.push({ startSec: cursor, endSec: videoDuration })
  }

  if (segments.length === 0) {
    return sourceVideo // No zoom needed
  }

  // Render each segment
  const segmentPaths: string[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const segPath = path.join(tmpDir, `zoom-seg-${i}.mp4`)
    segmentPaths.push(segPath)

    const args = ['-y', '-i', sourceVideo, '-ss', String(seg.startSec), '-to', String(seg.endSec)]

    if (seg.zoom) {
      const z = seg.zoom
      const cropW = Math.round(width / z.level)
      const cropH = Math.round(height / z.level)
      const cx = Math.round(z.x * width)
      const cy = Math.round(z.y * height)
      const cropX = Math.max(0, Math.min(cx - cropW / 2, width - cropW))
      const cropY = Math.max(0, Math.min(cy - cropH / 2, height - cropH))

      args.push('-vf', `crop=${cropW}:${cropH}:${Math.round(cropX)}:${Math.round(cropY)},scale=${width}:${height}`)
    } else {
      args.push('-vf', `scale=${width}:${height}`)
    }

    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an', segPath)
    ffmpeg(args)
  }

  // Concatenate segments
  const concatFile = path.join(tmpDir, 'zoom-concat.txt')
  fs.writeFileSync(concatFile, segmentPaths.map((p) => `file '${p}'`).join('\n'))

  const concatOutput = path.join(tmpDir, 'zoom-combined.mp4')
  ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', concatOutput])

  return concatOutput
}

/**
 * Render final video from trace data.
 */
export function renderVideo(
  trace: RenderableTrace,
  config: RenderConfig,
  outputPath: string,
  tmpDir: string,
): void {
  const sourceVideo = trace.sourceVideoPath
  if (!sourceVideo || !fs.existsSync(sourceVideo)) {
    throw new Error(`Source video not found: ${sourceVideo}`)
  }

  const format = config.format ?? 'mp4'
  const resolution = resolveResolution(config.resolution)
  const crf = config.crf ?? 23

  const hasZoom = trace.subtitles?.some((s) => s.zoom && s.zoom.level > 1.0) ?? false
  const hasAudio = trace.voiceover?.audioTrackPath &&
    fs.existsSync(trace.voiceover.audioTrackPath)

  // Phase 1: Apply zoom if needed (segment-based crop+scale+concat)
  let videoInput = sourceVideo
  if (hasZoom && trace.subtitles) {
    videoInput = renderWithZoom(
      sourceVideo,
      trace.subtitles,
      resolution.width,
      resolution.height,
      tmpDir,
    )
  }

  // Phase 1.5: Trim blank frames at the start of the video.
  // Must re-encode because webm/vp8 stream-copy seeks to nearest keyframe.
  const blankLeadIn = detectBlankLeadIn(videoInput, tmpDir)
  if (blankLeadIn > 0) {
    const trimmedPath = path.join(tmpDir, 'trimmed-input.mp4')
    ffmpeg([
      '-y', '-ss', String(blankLeadIn), '-i', videoInput,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      trimmedPath,
    ])
    videoInput = trimmedPath
  }

  // Phase 2: Final encode (audio merge + subtitle burn + format)
  const ffmpegArgs: string[] = ['-y', '-i', videoInput]

  if (hasAudio && trace.voiceover) {
    ffmpegArgs.push('-i', trace.voiceover.audioTrackPath)
  }

  const vFilters: string[] = []

  // Scale (only if no zoom was applied — zoom already scaled)
  if (!hasZoom) {
    vFilters.push(`scale=${resolution.width}:${resolution.height}`)
  }

  if (config.burnSubtitles && trace.subtitles && trace.subtitles.length > 0) {
    const srtPath = path.join(tmpDir, 'burn-subtitles.srt')
    fs.writeFileSync(srtPath, writeSrt(trace.subtitles))
    const escapedPath = srtPath.replace(/'/g, "'\\''").replace(/:/g, '\\:')
    vFilters.push(`subtitles='${escapedPath}'`)
  }

  if (vFilters.length > 0) {
    ffmpegArgs.push('-vf', vFilters.join(','))
  }

  if (format === 'mp4') {
    ffmpegArgs.push('-c:v', config.codec ?? 'libx264', '-preset', 'fast', '-crf', String(crf))
  } else {
    ffmpegArgs.push('-c:v', config.codec ?? 'libvpx-vp9', '-crf', String(crf), '-b:v', '0')
  }

  if (hasAudio) {
    ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
  }

  if (config.fps) {
    ffmpegArgs.push('-r', String(config.fps))
  }

  ffmpegArgs.push(outputPath)
  ffmpeg(ffmpegArgs)
}
