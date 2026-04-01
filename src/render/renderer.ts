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
import { writeDefaultClickSound } from '../click-effect/defaults.js'
import { generateClickSoundTrack, getAudioDurationMs as getClickAudioDurationMs } from '../click-effect/sound-track.js'
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
  clickEvents?: ClickEvent[]
  clickEffectConfig?: { color: string; opacity: number; radius: number; duration: number; soundVolume: number; sound?: string | true }
  cursorKeyframes?: CursorKeyframe[]
  cursorOverlayConfig?: ResolvedCursorOverlayConfig
  zoomConfig?: { transitionMs?: number; easing?: import('../types/easing.js').EasingSpec }
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
 * Probe the actual resolution of a video file.
 */
function probeResolution(videoPath: string): { width: number; height: number } {
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
    '-filter_complex', '[0:v][1:v]overlay=0:0:eof_action=repeat:format=auto[out]',
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
    `[0:v][cursor]overlay=x='${xExpr}':y='${yExpr}':enable='${enableExpr}':eof_action=pass:format=auto[out]`,
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
      `[${prevLabel}][${rippleLabel}]overlay=${ox}:${oy}:eof_action=pass:format=auto[${outLabel}]`,
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
      trace.zoomConfig,
    )
  }

  // Phase 3.25: Apply cursor overlay (renders below click effects)
  if (trace.cursorKeyframes && trace.cursorKeyframes.length > 0 && trace.cursorOverlayConfig) {
    videoInput = renderWithCursorOverlay(
      videoInput,
      trace.cursorKeyframes,
      trace.cursorOverlayConfig,
      trace.metadata.viewport,
      tmpDir,
    )
  }

  // Phase 3.5: Apply click effect overlays
  if (trace.clickEvents && trace.clickEvents.length > 0 && trace.clickEffectConfig) {
    videoInput = renderWithClickEffects(
      videoInput,
      trace.clickEvents,
      trace.clickEffectConfig,
      trace.metadata.viewport,
      tmpDir,
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

    const soundDurationMs = getClickAudioDurationMs(soundPath)

    clickSoundTrackPath = generateClickSoundTrack(
      {
        clicks: trace.clickEvents,
        soundPath,
        soundDurationMs,
        outputPath: path.join(tmpDir, 'click-sound-track.mp3'),
        volume: trace.clickEffectConfig.soundVolume,
      },
      tmpDir,
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
    // Mix click sound into voiceover track
    const mixedPath = path.join(tmpDir, 'mixed-audio.mp3')
    ffmpeg([
      '-y', '-i', finalAudioPath, '-i', clickSoundTrackPath,
      '-filter_complex', '[0:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a0];[1:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a1];[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0',
      '-c:a', 'libmp3lame', '-q:a', '2', mixedPath,
    ])
    finalAudioPath = mixedPath
  } else if (clickSoundTrackPath && !finalAudioPath) {
    finalAudioPath = clickSoundTrackPath
  }

  if (finalAudioPath) {
    ffmpegArgs.push('-i', finalAudioPath)
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

  if (finalAudioPath) {
    ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k')
  }

  if (config.fps) {
    ffmpegArgs.push('-r', String(config.fps))
  }

  ffmpegArgs.push(outputPath)
  ffmpeg(ffmpegArgs)
}
