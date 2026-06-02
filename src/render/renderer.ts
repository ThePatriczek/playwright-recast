import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { RenderConfig } from '../types/render.js'
import { resolveResolution } from '../types/render.js'
import type { SubtitleEntry } from '../types/subtitle.js'
import type { SpeedSegment } from '../types/speed.js'
import type { ParsedTrace } from '../types/trace.js'
import type { ClickEvent } from '../types/click-effect.js'
import type { CursorKeyframe } from '../types/cursor-overlay.js'
import type { ResolvedCursorOverlayConfig } from '../cursor-overlay/defaults.js'
import { writeDefaultCursorImage } from '../cursor-overlay/defaults.js'
import { buildOverlayExpressions, buildEnableExpression } from '../cursor-overlay/expression-builder.js'
import { buildZoomFilter, stepZoomsToKeyframes, type ZoomExprConfig } from './zoom-expression.js'
import { generateRippleClip } from '../click-effect/ripple-generator.js'
import type { HighlightEvent } from '../types/text-highlight.js'
import { generateHighlightClip } from '../text-highlight/highlight-generator.js'
import { writeDefaultClickSound } from '../click-effect/defaults.js'
import { generateClickSoundTrack, getAudioDurationMs as getClickAudioDurationMs } from '../click-effect/sound-track.js'
import { writeSrt } from '../subtitles/srt-writer.js'
import { writeAss } from '../subtitles/ass-writer.js'
import { chunkSubtitles } from '../subtitles/subtitle-chunker.js'
import { filterRenderableSubtitles } from '../subtitles/renderable.js'
import { interpolateVideo } from '../interpolate/interpolator.js'

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
  voiceover?: {
    audioTrackPath: string
    entries: unknown[]
    totalDurationMs: number
    freezes?: Array<{ atVideoMs: number; durationMs: number }>
  }
  speedSegments?: SpeedSegment[]
  clickEvents?: ClickEvent[]
  clickEffectConfig?: { color: string; opacity: number; radius: number; duration: number; soundVolume: number; sound?: string | true }
  cursorKeyframes?: CursorKeyframe[]
  cursorOverlayConfig?: ResolvedCursorOverlayConfig
  zoomConfig?: { transitionMs?: number; easing?: import('../types/easing.js').EasingSpec }
  interpolateConfig?: import('../types/interpolate.js').InterpolateConfig
  highlightEvents?: import('../types/text-highlight.js').HighlightEvent[]
  highlightConfig?: import('../text-highlight/defaults.js').ResolvedTextHighlightConfig
}

export function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', args, { stdio: 'pipe' })
}

/**
 * Get video duration in seconds, handling containers without duration metadata
 * (e.g., Playwright webm recordings). Tries format duration first, then falls
 * back to probing the last packet timestamp.
 */
export function getVideoDuration(videoPath: string): number {
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
 * Probe the actual resolution of a video file.
 */
export function probeResolution(videoPath: string): { width: number; height: number } {
  const output = execFileSync('ffprobe', [
    '-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', videoPath,
  ]).toString().trim()
  const [w, h] = output.split(',').map(Number)
  return { width: w!, height: h! }
}

/**
 * Render with smooth zoom transitions in a single ffmpeg pass.
 * Uses dynamic crop expressions with easing for animated zoom in/out/pan.
 */
function renderWithZoom(
  sourceVideo: string,
  subtitles: SubtitleEntry[],
  targetWidth: number,
  targetHeight: number,
  tmpDir: string,
  zoomConfig?: { transitionMs?: number; easing?: import('../types/easing.js').EasingSpec },
): string {
  const zoomSubs = subtitles.filter((s) => s.zoom && s.zoom.level > 1.0)
  if (zoomSubs.length === 0) return sourceVideo

  const keyframes = stepZoomsToKeyframes(subtitles)
  if (keyframes.length === 0) return sourceVideo

  const srcRes = probeResolution(sourceVideo)

  // Probe fps from source video for zoompan frame-to-time conversion
  let fps = 25
  try {
    const fpsStr = execFileSync('ffprobe', [
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', sourceVideo,
    ]).toString().trim()
    const parts = fpsStr.split('/')
    const probedFps = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(fpsStr)
    if (probedFps > 0) fps = Math.round(probedFps)
  } catch { /* use default */ }

  const config: ZoomExprConfig = {
    transitionMs: zoomConfig?.transitionMs ?? 400,
    easing: zoomConfig?.easing ?? 'ease-in-out',
    fps,
  }

  const filter = buildZoomFilter(keyframes, srcRes, { width: targetWidth, height: targetHeight }, config)
  console.log(`  Zoom: zoompan single-pass (${keyframes.length} keyframes, ${fps}fps, easing: ${typeof config.easing === 'string' ? config.easing : 'custom'})`)

  const outputPath = path.join(tmpDir, 'zoom-combined.mp4')
  const videoDur = getVideoDuration(sourceVideo)
  ffmpeg([
    '-y', '-i', sourceVideo,
    '-filter_complex', `[0:v]${filter},setpts=N/${fps}/TB[zout]`,
    '-map', '[zout]',
    '-t', String(videoDur),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an', outputPath,
  ])

  return outputPath
}

/**
 * Apply an animated cursor overlay to the video.
 * Renders a cursor image that smoothly moves between action positions
 * using ffmpeg movie + overlay with time-based expressions.
 */
function renderWithCursorOverlay(
  sourceVideo: string,
  keyframes: CursorKeyframe[],
  config: ResolvedCursorOverlayConfig,
  viewport: { width: number; height: number },
  tmpDir: string,
): string {
  if (keyframes.length === 0) return sourceVideo

  const srcRes = probeResolution(sourceVideo)
  const scaleFactor = srcRes.height / 1080

  // Use custom image or bundled default arrow cursor
  const cursorPngPath = config.image ?? writeDefaultCursorImage(tmpDir)

  // Pre-render cursor PNG into a short transparent video clip for reliable looping.
  // ffmpeg 7.x PNG decoder can't re-read the same packet (inflate error on loop).
  // Workaround: create a transparent canvas via lavfi, overlay the PNG once
  // (eof_action=repeat holds the last frame), producing a loopable .mov clip.
  const cursorClipPath = path.join(tmpDir, 'cursor-clip.mov')
  const cursorRes = probeResolution(cursorPngPath)
  ffmpeg([
    '-y',
    '-f', 'lavfi', '-i', `color=c=black@0:s=${cursorRes.width}x${cursorRes.height}:d=1:r=30,format=rgba`,
    '-i', cursorPngPath,
    '-filter_complex', '[0:v][1:v]overlay=0:0:eof_action=repeat:format=yuv420[out]',
    '-map', '[out]',
    '-c:v', 'qtrle', '-pix_fmt', 'argb',
    cursorClipPath,
  ])

  // Build per-click position and visibility expressions
  const { x: xExpr, y: yExpr } = buildOverlayExpressions(keyframes, config, viewport, srcRes)
  const enableExpr = buildEnableExpression(keyframes)

  const escapedClipPath = cursorClipPath.replace(/'/g, "'\\''").replace(/\\/g, '\\\\')

  // movie loads the cursor clip as an infinitely looping source;
  // overlay animates position; enable controls per-click visibility
  const cursorStream = `movie='${escapedClipPath}':loop=0,setpts=N/30/TB,format=rgba[cursor]`
  const filterParts = [
    cursorStream,
    `[0:v][cursor]overlay=x='${xExpr}':y='${yExpr}':enable='${enableExpr}':eof_action=pass:format=yuv420[out]`,
  ]

  const outputPath = path.join(tmpDir, 'cursor-overlay.mp4')
  console.log(`  Cursor overlay: ${keyframes.length} keyframes via movie+overlay`)

  ffmpeg([
    '-y', '-i', sourceVideo,
    '-filter_complex', filterParts.join(';'),
    '-map', '[out]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an',
    outputPath,
  ])

  return outputPath
}

/**
 * Apply click ripple overlays to the video.
 * For each click event, overlays a pre-generated transparent ripple clip
 * at the click position/time using ffmpeg movie filter + overlay.
 */
function renderWithClickEffects(
  sourceVideo: string,
  clickEvents: ClickEvent[],
  config: { color: string; opacity: number; radius: number; duration: number },
  viewport: { width: number; height: number },
  tmpDir: string,
): string {
  if (clickEvents.length === 0) return sourceVideo

  const srcRes = probeResolution(sourceVideo)
  // Scale factor: radius is relative to 1080p
  const scaleFactor = srcRes.height / 1080

  // Generate the ripple clip once
  const ripplePath = path.join(tmpDir, 'ripple.mov')
  generateRippleClip({
    color: config.color,
    opacity: config.opacity,
    radius: config.radius,
    duration: config.duration,
    outputPath: ripplePath,
    scaleFactor,
  })

  const scaledRadius = Math.round(config.radius * scaleFactor)
  const rippleSize = scaledRadius * 2
  const s = rippleSize % 2 === 0 ? rippleSize : rippleSize + 1
  const halfSize = s / 2

  // Scale coordinates from viewport to source resolution
  const scaleX = srcRes.width / viewport.width
  const scaleY = srcRes.height / viewport.height

  // Build filter_complex with movie sources for each click.
  // Each movie instance creates an independent stream positioned at the click time.
  const filterParts: string[] = []
  let prevLabel = '0:v'

  for (let i = 0; i < clickEvents.length; i++) {
    const click = clickEvents[i]!
    const cx = Math.round(click.x * scaleX)
    const cy = Math.round(click.y * scaleY)
    const timeSec = (click.videoTimeMs / 1000).toFixed(3)
    const outLabel = `v${i}`
    const rippleLabel = `r${i}`

    // movie filter: read ripple, shift PTS to click time
    const escapedPath = ripplePath.replace(/'/g, "'\\''").replace(/\\/g, '\\\\')
    filterParts.push(
      `movie='${escapedPath}',setpts=PTS+${timeSec}/TB,format=rgba[${rippleLabel}]`,
    )
    // Overlay at click position (centered)
    const ox = Math.max(0, cx - Math.round(halfSize))
    const oy = Math.max(0, cy - Math.round(halfSize))
    filterParts.push(
      `[${prevLabel}][${rippleLabel}]overlay=${ox}:${oy}:eof_action=pass:format=yuv420[${outLabel}]`,
    )
    prevLabel = outLabel
  }

  const outputPath = path.join(tmpDir, 'click-overlay.mp4')

  console.log(`  Click overlay: ${clickEvents.length} ripples via movie+overlay`)

  ffmpeg([
    '-y', '-i', sourceVideo,
    '-filter_complex', filterParts.join(';'),
    '-map', `[${prevLabel}]`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an',
    outputPath,
  ])

  return outputPath
}

/**
 * Render text highlight overlays onto the video.
 * For each highlight, generates a marker clip (swipe-in + hold + fade-out)
 * and overlays it at the correct position and time.
 */
function renderWithHighlights(
  sourceVideo: string,
  highlightEvents: HighlightEvent[],
  viewport: { width: number; height: number },
  tmpDir: string,
): string {
  if (highlightEvents.length === 0) return sourceVideo

  const srcRes = probeResolution(sourceVideo)
  const scaleX = srcRes.width / viewport.width
  const scaleY = srcRes.height / viewport.height

  const filterParts: string[] = []
  let prevLabel = '0:v'

  for (let i = 0; i < highlightEvents.length; i++) {
    const hl = highlightEvents[i]!
    const scaledW = Math.max(2, Math.round(hl.width * scaleX))
    const scaledH = Math.max(2, Math.round(hl.height * scaleY))

    // Generate a unique highlight clip for this event
    const clipPath = path.join(tmpDir, `highlight_${i}.mov`)
    generateHighlightClip({
      color: hl.color,
      opacity: hl.opacity,
      width: scaledW,
      height: scaledH,
      swipeDuration: hl.swipeDuration,
      duration: hl.endTimeMs - hl.videoTimeMs - hl.fadeOut,
      fadeOut: hl.fadeOut,
      outputPath: clipPath,
    })

    const ox = Math.max(0, Math.round(hl.x * scaleX))
    const oy = Math.max(0, Math.round(hl.y * scaleY))
    const timeSec = (hl.videoTimeMs / 1000).toFixed(3)
    const outLabel = `hl${i}`
    const hlLabel = `h${i}`

    const escapedPath = clipPath.replace(/'/g, "'\\''").replace(/\\/g, '\\\\')
    filterParts.push(
      `movie='${escapedPath}',setpts=PTS+${timeSec}/TB,format=rgba[${hlLabel}]`,
    )
    filterParts.push(
      `[${prevLabel}][${hlLabel}]overlay=${ox}:${oy}:eof_action=pass:format=yuv420[${outLabel}]`,
    )
    prevLabel = outLabel
  }

  const outputPath = path.join(tmpDir, 'highlight-overlay.mp4')

  console.log(`  Highlight overlay: ${highlightEvents.length} markers via movie+overlay`)

  ffmpeg([
    '-y', '-i', sourceVideo,
    '-filter_complex', filterParts.join(';'),
    '-map', `[${prevLabel}]`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an',
    outputPath,
  ])

  return outputPath
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
  fs.writeFileSync(concatFile, segmentPaths.map((p) => `file '${path.basename(p)}'`).join('\n'))

  const concatOutput = path.join(tmpDir, 'speed-combined.mp4')
  ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', concatOutput])

  return concatOutput
}

/**
 * Hold the last frame at each freeze point so the narration audio has time to
 * finish before the next visual action. Splits the video at each freeze
 * position, holds the last frame of the preceding segment for the requested
 * duration, then concatenates everything back together.
 *
 * Freeze positions are in the speed-mapped (pre-freeze) video timeline.
 */
function applyVoiceoverFreezes(
  videoPath: string,
  freezes: Array<{ atVideoMs: number; durationMs: number }>,
  tmpDir: string,
): string {
  if (freezes.length === 0) return videoPath

  const videoDur = getVideoDuration(videoPath)
  const sorted = [...freezes]
    .map((f) => ({
      atSec: Math.max(0, Math.min(videoDur, f.atVideoMs / 1000)),
      durSec: Math.max(0, f.durationMs / 1000),
    }))
    .filter((f) => f.durSec > 0.01 && f.atSec < videoDur - 0.01)
    .sort((a, b) => a.atSec - b.atSec)

  if (sorted.length === 0) return videoPath

  const segPaths: string[] = []
  let prevEnd = 0
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]!
    if (f.atSec <= prevEnd + 0.01) continue
    const segPath = path.join(tmpDir, `vo-freeze-seg-${i}.mp4`)
    ffmpeg([
      '-y', '-ss', String(prevEnd), '-to', String(f.atSec),
      '-i', videoPath,
      '-vf', `tpad=stop_mode=clone:stop_duration=${f.durSec.toFixed(3)}`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an',
      segPath,
    ])
    segPaths.push(segPath)
    prevEnd = f.atSec
  }

  if (prevEnd < videoDur - 0.01) {
    const tailPath = path.join(tmpDir, 'vo-freeze-seg-tail.mp4')
    ffmpeg([
      '-y', '-ss', String(prevEnd),
      '-i', videoPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an',
      tailPath,
    ])
    segPaths.push(tailPath)
  }

  const totalFreezeSec = sorted.reduce((a, b) => a + b.durSec, 0)
  console.log(
    `  Voiceover freeze: ${sorted.length} hold(s), +${totalFreezeSec.toFixed(1)}s`,
  )

  const concatList = path.join(tmpDir, 'vo-freeze-concat.txt')
  fs.writeFileSync(
    concatList,
    segPaths.map((p) => `file '${path.basename(p)}'`).join('\n'),
  )
  const outputPath = path.join(tmpDir, 'vo-freezed.mp4')
  ffmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
    '-c', 'copy', outputPath,
  ])
  return outputPath
}

/**
 * Merge freeze entries at (near-)identical positions, summing durations.
 * applyVoiceoverFreezes() skips freezes within 0.01s of the previous one, but
 * shiftForFreezes() sums every entry — so coincident entries (e.g. a voiceover
 * freeze and a cursor-approach hold landing together) would desync the video
 * from the shifted overlays. Merging first keeps the two in agreement.
 */
function mergeFreezes(
  freezes: Array<{ atVideoMs: number; durationMs: number }>,
): Array<{ atVideoMs: number; durationMs: number }> {
  const sorted = [...freezes].sort((a, b) => a.atVideoMs - b.atVideoMs)
  const merged: Array<{ atVideoMs: number; durationMs: number }> = []
  for (const f of sorted) {
    const last = merged[merged.length - 1]
    if (last && f.atVideoMs - last.atVideoMs <= 10) {
      last.durationMs += f.durationMs
    } else {
      merged.push({ atVideoMs: f.atVideoMs, durationMs: f.durationMs })
    }
  }
  return merged
}

/**
 * Shift a pre-freeze video time forward by the cumulative freeze duration
 * that comes before it.
 */
function shiftForFreezes(
  originalMs: number,
  freezes: Array<{ atVideoMs: number; durationMs: number }>,
): number {
  let shift = 0
  for (const f of freezes) {
    if (f.atVideoMs <= originalMs) shift += f.durationMs
  }
  return originalMs + shift
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

  // Phase 2.5: Frame interpolation (on source resolution, before overlays and zoom upscale)
  if (trace.interpolateConfig) {
    const interpolatedPath = path.join(tmpDir, 'interpolated.mp4')
    interpolateVideo(videoInput, interpolatedPath, trace.interpolateConfig)
    videoInput = interpolatedPath
  }

  // Phase 3.3: Apply text highlight overlays (pre-freeze; highlights freeze
  // with the held frame, which is acceptable since their duration is
  // configured independently).
  if (trace.highlightEvents && trace.highlightEvents.length > 0) {
    videoInput = renderWithHighlights(
      videoInput,
      trace.highlightEvents,
      trace.metadata.viewport,
      tmpDir,
    )
  }

  // Phase 3.4: Voiceover-driven freezes. If a narration's audio is longer
  // than its visual window, the voiceover stage records "freeze" points so
  // the video holds the current frame until the audio finishes. We apply
  // freezes BEFORE cursor + click overlays so those overlays see the
  // freeze-extended timeline and stay in sync (cursor visibility is per-
  // click and built from the same videoTimeMs the ripple uses).
  const voiceoverFreezes = trace.voiceover?.freezes ?? []
  // Approach holds (marker-driven cursor glides) are normally produced by the
  // voiceover stage so the audio + subtitles stay in sync, arriving here inside
  // trace.voiceover.freezes. Only when there is no voiceover do we compute them
  // here — there's no audio to keep in sync, but the video still needs the hold.
  const approachFreezes: Array<{ atVideoMs: number; durationMs: number }> = []
  if (!trace.voiceover && trace.cursorKeyframes) {
    const approachMs = trace.cursorOverlayConfig?.approachMs ?? 500
    for (const kf of trace.cursorKeyframes) {
      if (kf.approach) {
        approachFreezes.push({
          atVideoMs: Math.max(0, Math.round(kf.videoTimeSec * 1000) - 2), // -2ms: ripple + cursor shift into the hold
          durationMs: Math.round(approachMs),
        })
      }
    }
  }
  const allFreezes = mergeFreezes([...voiceoverFreezes, ...approachFreezes])
  if (allFreezes.length > 0) {
    videoInput = applyVoiceoverFreezes(videoInput, allFreezes, tmpDir)
    if (trace.clickEvents) {
      for (const ce of trace.clickEvents) {
        ce.videoTimeMs = shiftForFreezes(ce.videoTimeMs, allFreezes)
      }
    }
    if (trace.cursorKeyframes) {
      for (const kf of trace.cursorKeyframes) {
        kf.videoTimeSec =
          shiftForFreezes(kf.videoTimeSec * 1000, allFreezes) / 1000
      }
    }
  }

  // Phase 3.45: Apply cursor overlay on the freeze-extended timeline. The
  // per-click appear/move/disappear window references the same shifted
  // videoTimeSec as the click ripple, so the cursor approaches and the
  // ripple fires in sync — exactly as in the no-freeze case.
  if (trace.cursorKeyframes && trace.cursorKeyframes.length > 0 && trace.cursorOverlayConfig) {
    videoInput = renderWithCursorOverlay(
      videoInput,
      trace.cursorKeyframes,
      trace.cursorOverlayConfig,
      trace.metadata.viewport,
      tmpDir,
    )
  }

  // Phase 3.46: Apply click ripples on the freeze-extended timeline, using
  // the already-shifted videoTimeMs.
  if (trace.clickEvents && trace.clickEvents.length > 0 && trace.clickEffectConfig) {
    videoInput = renderWithClickEffects(
      videoInput,
      trace.clickEvents,
      trace.clickEffectConfig,
      trace.metadata.viewport,
      tmpDir,
    )
  }

  // Phase 3.5: Apply zoom if needed (operates on speed-adjusted video with
  // baked-in overlays — same invariant as before the reorder).
  if (hasZoom && trace.subtitles) {
    videoInput = renderWithZoom(
      videoInput,
      trace.subtitles,
      resolution.width,
      resolution.height,
      tmpDir,
      trace.zoomConfig,
    )
  }

  // Phase 3.7: Generate click sound track if configured
  let clickSoundTrackPath: string | undefined
  if (trace.clickEvents && trace.clickEvents.length > 0 && trace.clickEffectConfig?.sound) {
    let soundPath: string

    if (trace.clickEffectConfig.sound === true) {
      // Use bundled default click sound
      soundPath = writeDefaultClickSound(tmpDir)
    } else {
      soundPath = trace.clickEffectConfig.sound
    }

    clickSoundTrackPath = generateClickSoundTrack(
      {
        clicks: trace.clickEvents,
        soundPath,
        outputPath: path.join(tmpDir, 'click-sound-track.mp3'),
        volume: trace.clickEffectConfig.soundVolume,
      },
    )
    if (clickSoundTrackPath) {
      console.log(`  Click sound: ${trace.clickEvents.length} sounds mixed`)
    }
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

  // Determine final audio track (mix voiceover + click sound if both present)
  let finalAudioPath: string | undefined
  if (hasAudio && trace.voiceover) {
    finalAudioPath = trace.voiceover.audioTrackPath
  }

  if (clickSoundTrackPath && finalAudioPath) {
    // Pad click sound track to match voiceover length via concat (no re-encoding).
    // Without this, amix doubles voiceover volume when the shorter click track ends.
    const voDurMs = getClickAudioDurationMs(finalAudioPath)
    const clickDurMs = getClickAudioDurationMs(clickSoundTrackPath)
    let clickInput = clickSoundTrackPath
    if (clickDurMs < voDurMs - 100) {
      const padDurSec = ((voDurMs - clickDurMs) / 1000).toFixed(3)
      const silencePath = path.join(tmpDir, 'click-tail-silence.mp3')
      ffmpeg([
        '-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono`,
        '-t', padDurSec, '-c:a', 'libmp3lame', '-q:a', '9', silencePath,
      ])
      const concatList = path.join(tmpDir, 'click-pad-concat.txt')
      fs.writeFileSync(concatList, `file '${path.basename(clickSoundTrackPath)}'\nfile '${path.basename(silencePath)}'`)
      const paddedPath = path.join(tmpDir, 'click-sound-padded.mp3')
      ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', paddedPath])
      clickInput = paddedPath
    }

    // Mix click sound into voiceover track
    const mixedPath = path.join(tmpDir, 'mixed-audio.mp3')
    ffmpeg([
      '-y', '-i', finalAudioPath, '-i', clickInput,
      '-filter_complex', '[0:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a0];[1:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a1];[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0',
      '-c:a', 'libmp3lame', '-q:a', '2', mixedPath,
    ])
    finalAudioPath = mixedPath
  } else if (clickSoundTrackPath && !finalAudioPath) {
    finalAudioPath = clickSoundTrackPath
  }

  if (finalAudioPath) {
    ffmpegArgs.push('-i', finalAudioPath)
  }

  // Optional soft-subtitle track muxed into the container. The viewer can
  // toggle this on/off in their player (independent of any burned-in style).
  // All `-i` inputs MUST be pushed before any output options like `-vf` or
  // `-map`, otherwise ffmpeg attributes those options to the wrong file.
  // Drop narration lines still at zero duration (no voiceover sized them) so we
  // never write a degenerate SRT/ASS cue. NOTE: the zoom reads on
  // `trace.subtitles` above (the `hasZoom` check and the zoom application block)
  // are intentionally left on the full list.
  const renderableSubtitles = filterRenderableSubtitles(trace.subtitles ?? [])

  const embedOpt = config.embedSubtitles
  const wantEmbed = !!embedOpt && renderableSubtitles.length > 0
  let subInputIndex = -1
  if (wantEmbed) {
    const embedEntries = config.subtitleStyle?.chunkOptions
      ? chunkSubtitles(renderableSubtitles, config.subtitleStyle.chunkOptions)
      : renderableSubtitles
    const embedSrtPath = path.join(tmpDir, 'embed-subtitles.srt')
    fs.writeFileSync(embedSrtPath, writeSrt(embedEntries))
    subInputIndex = finalAudioPath ? 2 : 1
    ffmpegArgs.push('-i', embedSrtPath)
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

  if (config.burnSubtitles && renderableSubtitles.length > 0) {
    if (config.subtitleStyle) {
      // Styled subtitles via ASS format (background box, custom font, etc.)
      let burnEntries = renderableSubtitles
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
      fs.writeFileSync(srtPath, writeSrt(renderableSubtitles))
      const escapedPath = srtPath.replace(/'/g, "'\\''").replace(/:/g, '\\:')
      vFilters.push(`subtitles='${escapedPath}'`)
    }
  }

  if (vFilters.length > 0) {
    ffmpegArgs.push('-vf', vFilters.join(','))
  }

  if (wantEmbed) {
    // With extra inputs, explicit -map is needed so ffmpeg picks all three
    // streams instead of falling back to its single-best-stream default.
    ffmpegArgs.push('-map', '0:v:0')
    if (finalAudioPath) ffmpegArgs.push('-map', '1:a:0')
    ffmpegArgs.push('-map', `${subInputIndex}:s:0`)
  }

  if (format === 'mp4') {
    ffmpegArgs.push('-c:v', config.codec ?? 'libx264', '-preset', 'fast', '-crf', String(crf))
  } else {
    ffmpegArgs.push('-c:v', config.codec ?? 'libvpx-vp9', '-crf', String(crf), '-b:v', '0')
  }

  if (finalAudioPath) {
    ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k')
  }

  if (wantEmbed) {
    // mp4 uses mov_text; webm uses webvtt. ffmpeg transcodes the SRT input
    // into the chosen codec automatically.
    ffmpegArgs.push('-c:s', format === 'mp4' ? 'mov_text' : 'webvtt')

    const meta = typeof embedOpt === 'object' && embedOpt ? embedOpt : {}
    const language = meta.language ?? 'eng'
    const title = meta.title ?? 'Subtitles'
    ffmpegArgs.push(`-metadata:s:s:0`, `language=${language}`)
    ffmpegArgs.push(`-metadata:s:s:0`, `title=${title}`)
    if (meta.default !== false) {
      ffmpegArgs.push('-disposition:s:0', 'default')
    }
  }

  if (config.fps) {
    ffmpegArgs.push('-r', String(config.fps))
  }

  ffmpegArgs.push(outputPath)
  ffmpeg(ffmpegArgs)
}
