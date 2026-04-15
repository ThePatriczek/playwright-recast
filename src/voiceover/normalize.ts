import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LoudnessNormalizeConfig } from '../types/voiceover.js'

const execFileAsync = promisify(execFile)

const DEFAULTS = {
  targetLufs: -16,
  truePeakDb: -1,
  lra: 11,
  linear: true,
  sampleRate: 44100,
  bitrate: '128k',
} as const

interface Pass1Measurement {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

/**
 * Two-pass EBU R128 loudness normalization via ffmpeg's `loudnorm` filter.
 *
 * Pass 1 measures the input; pass 2 applies linear gain with measured values
 * so the output exactly meets the target (within loudnorm's ±0.5 LU accuracy).
 * Linear mode preserves dynamics — recommended for speech.
 */
export async function normalizeLoudness(
  inputPath: string,
  outputPath: string,
  config: LoudnessNormalizeConfig = {},
): Promise<void> {
  const cfg = { ...DEFAULTS, ...config }

  const pass1Filter =
    `loudnorm=I=${cfg.targetLufs}:TP=${cfg.truePeakDb}:LRA=${cfg.lra}:print_format=json`

  const { stderr: pass1Stderr } = await execFileAsync('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', inputPath,
    '-af', pass1Filter,
    '-f', 'null', '-',
  ], { maxBuffer: 10 * 1024 * 1024 })

  const measured = parseLoudnormJson(pass1Stderr)

  // `linear=true` must come BEFORE `offset` — in some ffmpeg builds the
  // expression parser consumes the following option as part of the offset
  // numeric expression when the order is reversed.
  const pass2Filter = 'loudnorm=' + [
    cfg.linear ? 'linear=true' : 'linear=false',
    `I=${cfg.targetLufs}`,
    `TP=${cfg.truePeakDb}`,
    `LRA=${cfg.lra}`,
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    'print_format=summary',
  ].join(':')

  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-af', pass2Filter,
    '-ar', String(cfg.sampleRate),
    '-ac', '1',
    '-c:a', 'libmp3lame',
    '-b:a', cfg.bitrate,
    outputPath,
  ], { maxBuffer: 10 * 1024 * 1024 })
}

/** Extract the JSON block printed by `loudnorm` pass 1. */
function parseLoudnormJson(stderr: string): Pass1Measurement {
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`loudnorm pass 1 produced no JSON output:\n${stderr}`)
  }
  const json = stderr.slice(start, end + 1)
  const parsed = JSON.parse(json) as Partial<Pass1Measurement>
  for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const) {
    if (typeof parsed[k] !== 'string') {
      throw new Error(`loudnorm pass 1 JSON missing field '${k}':\n${json}`)
    }
  }
  return parsed as Pass1Measurement
}
