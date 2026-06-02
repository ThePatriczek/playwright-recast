import { execFileSync } from 'node:child_process'

export interface ClickSoundInput {
  clicks: Array<{ videoTimeMs: number }>
  soundPath: string
  outputPath: string
  volume: number
}

export interface ClickSoundPlan {
  /** Absolute start time (ms) for each click sound, sorted ascending. */
  delaysMs: number[]
}

/**
 * Plan the click sound track: one sound per click, placed at the click's exact
 * video time.
 *
 * Unlike a sequential silence+sound concatenation, this keeps EVERY click —
 * including ones spaced closer than the sound's duration. Those simply overlap
 * (mixed by {@link generateClickSoundTrack}), matching the ripple overlays,
 * which are likewise drawn for every click regardless of spacing. Dropping
 * close clicks here is what left rapid clicks (e.g. focus-then-type) with a
 * visible ripple but no audible click.
 */
export function buildClickSoundPlan(
  clicks: Array<{ videoTimeMs: number }>,
): ClickSoundPlan {
  const delaysMs = clicks
    .map((c) => Math.max(0, Math.round(c.videoTimeMs)))
    .sort((a, b) => a - b)
  return { delaysMs }
}

/**
 * Generate the click sound audio track.
 *
 * Delays a copy of the click sound to each click's video time and mixes them
 * together (`adelay` + `amix`), so overlapping clicks both sound. `normalize=0`
 * keeps each click at full volume; coincident clicks sum.
 */
export function generateClickSoundTrack(input: ClickSoundInput): string {
  const { delaysMs } = buildClickSoundPlan(input.clicks)
  if (delaysMs.length === 0) return ''

  const n = delaysMs.length
  const vol = Math.abs(input.volume - 1.0) > 0.01 ? `,volume=${input.volume}` : ''

  let filterComplex: string
  if (n === 1) {
    filterComplex = `[0:a]adelay=${delaysMs[0]}:all=1${vol}[out]`
  } else {
    const labels = Array.from({ length: n }, (_, i) => `[s${i}]`).join('')
    const parts: string[] = [`[0:a]asplit=${n}${labels}`]
    for (let i = 0; i < n; i++) {
      parts.push(`[s${i}]adelay=${delaysMs[i]}:all=1${vol}[d${i}]`)
    }
    const mixIn = Array.from({ length: n }, (_, i) => `[d${i}]`).join('')
    parts.push(
      `${mixIn}amix=inputs=${n}:duration=longest:normalize=0:dropout_transition=0[out]`,
    )
    filterComplex = parts.join(';')
  }

  execFileSync('ffmpeg', [
    '-y', '-i', input.soundPath,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-c:a', 'libmp3lame', '-q:a', '2',
    input.outputPath,
  ], { stdio: 'pipe' })

  return input.outputPath
}

/** Get audio duration in ms using ffprobe */
export function getAudioDurationMs(audioPath: string): number {
  const out = execFileSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath,
  ]).toString().trim()
  return Math.round(Number(out) * 1000)
}
