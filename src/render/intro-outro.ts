import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IntroConfig, OutroConfig } from '../types/intro-outro.js'
import { probeResolution } from './renderer.js'
import { probeFps, normalizeVideo, crossfadeVideos } from './video-ops.js'

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
