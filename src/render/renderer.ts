import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { RenderConfig } from '../types/render.js'
import { resolveResolution } from '../types/render.js'
import type { SubtitleEntry } from '../types/subtitle.js'
import type { SpeedSegment } from '../types/speed.js'
import type { ParsedTrace } from '../types/trace.js'
import { writeSrt } from '../subtitles/srt-writer.js'
import { writeAss } from '../subtitles/ass-writer.js'
import { chunkSubtitles } from '../subtitles/subtitle-chunker.js'

/**
 * Detect blank/white frames at the start of a video and return the timestamp
 * of the first non-blank frame. Blank frames are identified by file size —
 * a solid-color frame compresses to a very small PNG.
 *
 * @returns Seconds to skip at the start, or 0 if no blank frames.
 */
export function detectBlankLeadIn(videoPath: string, tmpDir: string): number {
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
  speedSegments?: SpeedSegment[]
}

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', args, { stdio: 'pipe' })
}

/**
 * Get video duration in seconds, handling containers without duration metadata
 * (e.g., Playwright webm recordings). Tries format duration first, then falls
 * back to probing the last packet timestamp.
 */
function getVideoDuration(videoPath: string): number {
  // Try format-level duration first (fast)
  const durationStr = execFileSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath,
  ]).toString().trim()
  const duration = Number(durationStr)
  if (!Number.isNaN(duration) && duration > 0) return duration

  // Fallback: probe stream duration (some containers have it per-stream)
  const streamStr = execFileSync('ffprobe', [
    '-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=duration', '-of', 'csv=p=0', videoPath,
  ]).toString().trim()
  const streamDuration = Number(streamStr)
  if (!Number.isNaN(streamDuration) && streamDuration > 0) return streamDuration

  // Final fallback: compute from packet count and frame rate
  const probeOut = execFileSync('ffprobe', [
    '-v', 'quiet', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets,r_frame_rate', '-of', 'csv=p=0', videoPath,
  ]).toString().trim()
  const [fpsStr, nbPackets] = probeOut.split(',')
  const packets = Number(nbPackets)
  // Parse fractional fps like "25/1"
  const fpsParts = (fpsStr ?? '').split('/')
  const fps = fpsParts.length === 2
    ? Number(fpsParts[0]) / Number(fpsParts[1])
    : Number(fpsStr)
  if (packets > 0 && fps > 0) return packets / fps

  throw new Error(`Cannot determine duration of video: ${videoPath}`)
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

  // Get video duration (handles webm without duration header)
  const videoDuration = getVideoDuration(sourceVideo)

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
 * Apply speed segments to video: split into chunks, apply speed factor
 * with setpts, concatenate back together.
 *
 * Returns path to the speed-processed video (or original if no changes needed).
 */
function renderWithSpeed(
  sourceVideo: string,
  speedSegments: SpeedSegment[],
  baselineMs: number,
  tmpDir: string,
): string {
  if (speedSegments.length === 0) return sourceVideo

  // Check if any segment actually changes speed
  const allRealtime = speedSegments.every((s) => Math.abs(s.speed - 1.0) < 0.01)
  if (allRealtime) return sourceVideo

  // Get source video duration for clamping (handles webm without duration header)
  const videoDuration = getVideoDuration(sourceVideo)

  // Convert speed segments from trace monotonic time to video-relative seconds.
  // baselineMs is the first screencast frame timestamp — the video's t=0 reference.
  // Segments before baseline (from hidden setup context) get negative times → filtered out.
  const videoSegments = speedSegments
    .map((seg) => ({
      startSec: Math.max(0, ((seg.originalStart as number) - baselineMs) / 1000),
      endSec: Math.min(videoDuration, ((seg.originalEnd as number) - baselineMs) / 1000),
      speed: seg.speed,
    }))
    .filter((s) => s.endSec > s.startSec + 0.05)

  if (videoSegments.length === 0) return sourceVideo

  console.log(`  Speed: ${videoSegments.length} segments, source ${videoDuration.toFixed(1)}s`)

  // Process each segment
  const segmentPaths: string[] = []
  for (let i = 0; i < videoSegments.length; i++) {
    const seg = videoSegments[i]!
    const segPath = path.join(tmpDir, `speed-seg-${i}.mp4`)
    const duration = seg.endSec - seg.startSec
    const outputDuration = duration / seg.speed

    const args = [
      '-y', '-ss', String(seg.startSec), '-to', String(seg.endSec),
      '-i', sourceVideo,
      '-filter:v', `setpts=PTS/${seg.speed}`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an',
      segPath,
    ]
    ffmpeg(args)

    console.log(`    Seg ${i}: ${seg.startSec.toFixed(1)}s-${seg.endSec.toFixed(1)}s @ ${seg.speed}x → ${outputDuration.toFixed(1)}s`)
    segmentPaths.push(segPath)
  }

  // Concatenate all segments
  const concatFile = path.join(tmpDir, 'speed-concat.txt')
  fs.writeFileSync(concatFile, segmentPaths.map((p) => `file '${p}'`).join('\n'))

  const concatOutput = path.join(tmpDir, 'speed-combined.mp4')
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
  const hasSpeed = trace.speedSegments && trace.speedSegments.length > 0 &&
    trace.speedSegments.some((s) => Math.abs(s.speed - 1.0) > 0.01)

  // Phase 1: Trim blank frames at the start of the video.
  let videoInput = sourceVideo
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

  // Phase 2: Apply speed segments (changes duration, before zoom/subtitles).
  // Use the first screencast frame from the RECORDING page as baseline.
  // The recording page is identified by the last frame's pageId (it runs longest).
  if (hasSpeed && trace.speedSegments) {
    const recordingPageId = trace.frames.length > 0
      ? trace.frames[trace.frames.length - 1]!.pageId : undefined
    const recordingFrames = recordingPageId
      ? trace.frames.filter((f) => f.pageId === recordingPageId) : trace.frames
    const firstRecFrameTime = recordingFrames.length > 0
      ? (recordingFrames[0]!.timestamp as number)
      : (trace.speedSegments[0]!.originalStart as number)
    videoInput = renderWithSpeed(videoInput, trace.speedSegments, firstRecFrameTime, tmpDir)
  }

  // Phase 3: Apply zoom if needed (operates on speed-adjusted video with speed-adjusted times)
  if (hasZoom && trace.subtitles) {
    videoInput = renderWithZoom(
      videoInput,
      trace.subtitles,
      resolution.width,
      resolution.height,
      tmpDir,
    )
  }

  // Phase 4: Compute extra padding needed if audio is longer than video.
  // The tpad filter will be added in Phase 5's vFilters to hold the last frame.
  let tpadDuration = 0
  if (hasAudio && trace.voiceover) {
    const videoDur = getVideoDuration(videoInput)
    const audioDur = trace.voiceover.totalDurationMs / 1000
    if (audioDur > videoDur + 0.5) {
      tpadDuration = audioDur - videoDur + 1.0 // +1s buffer
      console.log(`  Will pad video by ${tpadDuration.toFixed(1)}s to match audio (${audioDur.toFixed(1)}s)`)
    }
  }

  // Phase 5: Final encode (audio merge + subtitle burn + format)
  const ffmpegArgs: string[] = ['-y', '-i', videoInput]

  if (hasAudio && trace.voiceover) {
    ffmpegArgs.push('-i', trace.voiceover.audioTrackPath)
  }

  const vFilters: string[] = []

  // Pad video with last frame to match audio duration
  if (tpadDuration > 0) {
    vFilters.push(`tpad=stop_mode=clone:stop_duration=${tpadDuration.toFixed(3)}`)
  }

  // Scale (only if no zoom was applied — zoom already scaled)
  if (!hasZoom) {
    vFilters.push(`scale=${resolution.width}:${resolution.height}`)
  }

  if (config.burnSubtitles && trace.subtitles && trace.subtitles.length > 0) {
    if (config.subtitleStyle) {
      // Styled subtitles via ASS format (background box, custom font, etc.)
      let burnEntries = trace.subtitles
      if (config.subtitleStyle.chunkOptions) {
        burnEntries = chunkSubtitles(burnEntries, config.subtitleStyle.chunkOptions)
      }
      const assPath = path.join(tmpDir, 'burn-subtitles.ass')
      fs.writeFileSync(assPath, writeAss(burnEntries, config.subtitleStyle, resolution))
      const escapedPath = assPath.replace(/'/g, "'\\''").replace(/:/g, '\\:')
      vFilters.push(`ass='${escapedPath}'`)
    } else {
      // Plain SRT subtitles (default ffmpeg styling)
      const srtPath = path.join(tmpDir, 'burn-subtitles.srt')
      fs.writeFileSync(srtPath, writeSrt(trace.subtitles))
      const escapedPath = srtPath.replace(/'/g, "'\\''").replace(/:/g, '\\:')
      vFilters.push(`subtitles='${escapedPath}'`)
    }
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
    ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k')
  }

  if (config.fps) {
    ffmpegArgs.push('-r', String(config.fps))
  }

  ffmpegArgs.push(outputPath)
  ffmpeg(ffmpegArgs)
}
