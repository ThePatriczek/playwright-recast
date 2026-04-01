import * as fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { InterpolateConfig, InterpolateMode, InterpolateQuality } from '../types/interpolate.js'

interface MinterpolateParams {
  mc_mode: string
  me_mode: string
  vsbmc: number
  search_param: number
}

const QUALITY_PRESETS: Record<InterpolateQuality, MinterpolateParams> = {
  fast: { mc_mode: 'obmc', me_mode: 'bilat', vsbmc: 0, search_param: 32 },
  balanced: { mc_mode: 'aobmc', me_mode: 'bidir', vsbmc: 1, search_param: 64 },
  quality: { mc_mode: 'aobmc', me_mode: 'bidir', vsbmc: 1, search_param: 400 },
}

/**
 * Build the minterpolate filter string for a given target FPS.
 * Exported for testing.
 */
export function buildMinterpolateFilter(config: InterpolateConfig, targetFps?: number): string {
  const fps = targetFps ?? config.fps ?? 60
  const mode: InterpolateMode = config.mode ?? 'mci'
  const quality: InterpolateQuality = config.quality ?? 'balanced'

  // scd_threshold: scene change detection. When difference between frames exceeds
  // this threshold (0-100), frames are duplicated instead of interpolated.
  // Prevents ghosting artifacts at scene transitions / navigation boundaries.
  const scd = 5

  const parts = [`fps=${fps}`, `mi_mode=${mode}`, `scd=fdiff`, `scd_threshold=${scd}`]

  if (mode === 'mci') {
    const params = QUALITY_PRESETS[quality]
    parts.push(
      `mc_mode=${params.mc_mode}`,
      `me_mode=${params.me_mode}`,
      `vsbmc=${params.vsbmc}`,
      `search_param=${params.search_param}`,
    )
  }

  return `minterpolate=${parts.join(':')}`
}

/**
 * Compute intermediate FPS targets for multi-pass interpolation.
 * Distributes the FPS increase geometrically across passes.
 * E.g. sourceFps=25, targetFps=60, passes=2 → [39, 60]
 * Exported for testing.
 */
export function computePassFps(sourceFps: number, targetFps: number, passes: number): number[] {
  if (passes <= 1) return [targetFps]
  const ratio = targetFps / sourceFps
  const perPassRatio = Math.pow(ratio, 1 / passes)
  const result: number[] = []
  let current = sourceFps
  for (let i = 0; i < passes; i++) {
    current = i === passes - 1 ? targetFps : Math.round(current * perPassRatio)
    result.push(current)
  }
  return result
}

function probeSourceFps(inputPath: string): number {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', inputPath,
    ]).toString().trim()
    const parts = out.split('/')
    if (parts.length === 2) return Number(parts[0]) / Number(parts[1])
    return Number(out) || 25
  } catch {
    return 25
  }
}

function runSinglePass(inputPath: string, outputPath: string, filter: string): void {
  execFileSync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-vf', filter,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-an',
    outputPath,
  ], { stdio: 'pipe' })
}

/**
 * Apply frame interpolation to a video using ffmpeg's minterpolate filter.
 * Supports multi-pass for smoother results — each pass interpolates already-smoothed frames.
 */
export function interpolateVideo(
  inputPath: string,
  outputPath: string,
  config: InterpolateConfig,
): void {
  const passes = config.passes ?? 1
  const targetFps = config.fps ?? 60

  if (passes <= 1) {
    const filter = buildMinterpolateFilter(config)
    console.log(`  Interpolating: ${filter}`)
    runSinglePass(inputPath, outputPath, filter)
    return
  }

  const sourceFps = probeSourceFps(inputPath)
  const passFpsTargets = computePassFps(sourceFps, targetFps, passes)

  console.log(`  Interpolating: ${passes} passes (${sourceFps}fps → ${passFpsTargets.join(' → ')}fps)`)

  let currentInput = inputPath
  for (let i = 0; i < passes; i++) {
    const isLast = i === passes - 1
    const passOutput = isLast ? outputPath : outputPath.replace(/\.mp4$/, `-pass${i + 1}.mp4`)
    const filter = buildMinterpolateFilter(config, passFpsTargets[i])
    console.log(`    Pass ${i + 1}/${passes}: ${filter}`)
    runSinglePass(currentInput, passOutput, filter)

    // Clean up intermediate file from previous pass
    if (i > 0 && currentInput !== inputPath) {
      fs.unlinkSync(currentInput)
    }
    currentInput = passOutput
  }
}
