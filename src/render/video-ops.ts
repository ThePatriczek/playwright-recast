import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ffmpeg, getVideoDuration, probeResolution } from './renderer.js'

/**
 * Shared ffmpeg operations for stitching independently rendered videos
 * together. Used by intro/outro (crossfade onto one main video) and by the
 * suite orchestrator (concat many test clips).
 */

/** Detect whether a video file has an audio stream. */
export function probeHasAudio(videoPath: string): boolean {
  const output = execFileSync('ffprobe', [
    '-v', 'quiet', '-select_streams', 'a',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0', videoPath,
  ]).toString().trim()
  return output.length > 0
}

/** Probe the frame rate of a video file. Falls back to 30 when unreadable. */
export function probeFps(videoPath: string): number {
  try {
    const fpsStr = execFileSync('ffprobe', [
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', videoPath,
    ]).toString().trim()
    const parts = fpsStr.split('/')
    const fps = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(fpsStr)
    return fps > 0 ? fps : 30
  } catch {
    return 30
  }
}

/**
 * Normalize a video to match the target resolution, fps, and pixel format.
 * Uses letterboxing (black padding) if aspect ratios differ.
 */
export function normalizeVideo(
  inputPath: string,
  targetWidth: number,
  targetHeight: number,
  targetFps: number,
  tmpDir: string,
  label: string,
): string {
  const srcRes = probeResolution(inputPath)
  const srcFps = probeFps(inputPath)

  // Skip normalization if already matching
  if (
    srcRes.width === targetWidth &&
    srcRes.height === targetHeight &&
    Math.abs(srcFps - targetFps) < 1
  ) {
    return inputPath
  }

  const outputPath = path.join(tmpDir, `normalized-${label}.mp4`)
  const vf = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${targetFps}`

  ffmpeg([
    '-y', '-i', inputPath,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'aac', '-b:a', '128k',
    outputPath,
  ])

  return outputPath
}

/**
 * Ensure a video has an audio stream. If it doesn't, add a silent one.
 * Returns the path to a video that is guaranteed to have audio.
 */
export function ensureAudioStream(
  videoPath: string,
  tmpDir: string,
  label: string,
): string {
  if (probeHasAudio(videoPath)) return videoPath

  const dur = getVideoDuration(videoPath)
  const outputPath = path.join(tmpDir, `audio-${label}.mp4`)

  ffmpeg([
    '-y', '-i', videoPath,
    '-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=44100:cl=stereo',
    '-c:v', 'copy', '-c:a', 'aac', '-shortest',
    outputPath,
  ])

  return outputPath
}

/** Crossfade two videos together using xfade (video) and acrossfade (audio). */
export function crossfadeVideos(
  firstVideo: string,
  secondVideo: string,
  fadeDurationMs: number,
  tmpDir: string,
  outputPath: string,
): void {
  const firstDur = getVideoDuration(firstVideo)
  const secondDur = getVideoDuration(secondVideo)
  const fadeSec = fadeDurationMs / 1000

  // Clamp fade duration to not exceed either video
  const maxFade = Math.min(firstDur, secondDur) - 0.1
  const clampedFade = Math.min(fadeSec, Math.max(0.1, maxFade))
  if (clampedFade < fadeSec) {
    console.log(`  Intro/outro: fade duration clamped from ${fadeSec.toFixed(1)}s to ${clampedFade.toFixed(1)}s`)
  }

  const offset = (firstDur - clampedFade).toFixed(3)

  // Ensure both have audio
  const first = ensureAudioStream(firstVideo, tmpDir, 'xfade-first')
  const second = ensureAudioStream(secondVideo, tmpDir, 'xfade-second')

  const filterComplex = [
    `[0:v][1:v]xfade=transition=fade:duration=${clampedFade.toFixed(3)}:offset=${offset}[vout]`,
    `[0:a][1:a]acrossfade=d=${clampedFade.toFixed(3)}[aout]`,
  ].join(';')

  ffmpeg([
    '-y', '-i', first, '-i', second,
    '-filter_complex', filterComplex,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'aac', '-b:a', '128k',
    outputPath,
  ])
}

/**
 * Build the body of an ffmpeg concat-demuxer list file.
 * Single quotes in paths are escaped the way the demuxer expects.
 */
export function buildConcatList(videoPaths: readonly string[]): string {
  return videoPaths
    .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n') + '\n'
}

/**
 * Concatenate videos in order into a single file.
 *
 * Every input is normalized to the first video's resolution and fps and given
 * an audio stream, so clips rendered with different settings still join
 * cleanly. Concatenation itself uses the concat demuxer with a re-encode,
 * which is more forgiving of timestamp gaps than stream copy.
 */
export function concatVideos(
  videoPaths: readonly string[],
  tmpDir: string,
  outputPath: string,
): void {
  if (videoPaths.length === 0) {
    throw new Error('concatVideos: no input videos')
  }

  const first = videoPaths[0]!
  const { width, height } = probeResolution(first)
  const fps = probeFps(first)

  const prepared = videoPaths.map((videoPath, i) => {
    const normalized = normalizeVideo(videoPath, width, height, fps, tmpDir, `concat-${i}`)
    return ensureAudioStream(normalized, tmpDir, `concat-${i}`)
  })

  if (prepared.length === 1) {
    fs.copyFileSync(prepared[0]!, outputPath)
    return
  }

  const listPath = path.join(tmpDir, 'concat-list.txt')
  fs.writeFileSync(listPath, buildConcatList(prepared))

  ffmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'aac', '-b:a', '128k',
    '-fps_mode', 'cfr', '-r', String(fps),
    outputPath,
  ])
}
