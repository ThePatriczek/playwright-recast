import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { IntroConfig, OutroConfig } from '../types/intro-outro.js'
import { ffmpeg, getVideoDuration, probeResolution } from './renderer.js'

const DEFAULT_FADE_DURATION_MS = 500

export function resolveIntroConfig(config: IntroConfig): Required<IntroConfig> {
  return {
    path: config.path,
    fadeDuration: config.fadeDuration ?? DEFAULT_FADE_DURATION_MS,
  }
}

export function resolveOutroConfig(config: OutroConfig): Required<OutroConfig> {
  return {
    path: config.path,
    fadeDuration: config.fadeDuration ?? DEFAULT_FADE_DURATION_MS,
  }
}

/**
 * Detect whether a video file has an audio stream.
 */
function probeHasAudio(videoPath: string): boolean {
  const output = execFileSync('ffprobe', [
    '-v', 'quiet', '-select_streams', 'a',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0', videoPath,
  ]).toString().trim()
  return output.length > 0
}

/**
 * Probe the frame rate of a video file.
 */
function probeFps(videoPath: string): number {
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
function normalizeVideo(
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
function ensureAudioStream(
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

/**
 * Crossfade two videos together using xfade (video) and acrossfade (audio).
 */
function crossfadeVideos(
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
 * Apply intro and/or outro to the main video with crossfade transitions.
 * Operates on the final rendered video file, replacing it in place.
 */
export function applyIntroOutro(
  mainVideoPath: string,
  introConfig: IntroConfig | undefined,
  outroConfig: OutroConfig | undefined,
  tmpDir: string,
): void {
  if (!introConfig && !outroConfig) return

  const mainRes = probeResolution(mainVideoPath)
  const mainFps = probeFps(mainVideoPath)
  let current = mainVideoPath

  // Pass 1: Prepend intro with crossfade
  if (introConfig) {
    const resolved = resolveIntroConfig(introConfig)
    console.log(`  Intro: ${path.basename(resolved.path)} (fade: ${resolved.fadeDuration}ms)`)

    const normalizedIntro = normalizeVideo(
      resolved.path, mainRes.width, mainRes.height, mainFps, tmpDir, 'intro',
    )

    const introMerged = path.join(tmpDir, 'intro-merged.mp4')
    crossfadeVideos(normalizedIntro, current, resolved.fadeDuration, tmpDir, introMerged)
    current = introMerged
  }

  // Pass 2: Append outro with crossfade
  if (outroConfig) {
    const resolved = resolveOutroConfig(outroConfig)
    console.log(`  Outro: ${path.basename(resolved.path)} (fade: ${resolved.fadeDuration}ms)`)

    const normalizedOutro = normalizeVideo(
      resolved.path, mainRes.width, mainRes.height, mainFps, tmpDir, 'outro',
    )

    const outroMerged = path.join(tmpDir, 'outro-merged.mp4')
    crossfadeVideos(current, normalizedOutro, resolved.fadeDuration, tmpDir, outroMerged)
    current = outroMerged
  }

  // Replace the original output file
  if (current !== mainVideoPath) {
    fs.copyFileSync(current, mainVideoPath)
  }
}
