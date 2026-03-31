import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface ClickSoundInput {
  clicks: Array<{ videoTimeMs: number }>
  soundPath: string
  soundDurationMs: number
  outputPath: string
  volume: number
}

export interface ClickSoundPlan {
  /** Silence duration (ms) before each click sound */
  silenceDurations: number[]
  /** Filtered clicks (overlapping ones removed) */
  filteredClicks: Array<{ videoTimeMs: number }>
}

/**
 * Plan the click sound track: compute silence durations between clicks,
 * remove overlapping clicks.
 */
export function buildClickSoundArgs(input: ClickSoundInput): ClickSoundPlan {
  const sorted = [...input.clicks].sort((a, b) => a.videoTimeMs - b.videoTimeMs)

  const filtered: Array<{ videoTimeMs: number }> = []
  const silenceDurations: number[] = []
  let cursor = 0

  for (const click of sorted) {
    // Skip if this click overlaps with the previous sound
    if (filtered.length > 0 && click.videoTimeMs < cursor) {
      continue
    }

    const silenceMs = Math.max(0, click.videoTimeMs - cursor)
    silenceDurations.push(silenceMs)
    filtered.push(click)
    cursor = click.videoTimeMs + input.soundDurationMs
  }

  return { silenceDurations, filteredClicks: filtered }
}

/**
 * Generate the click sound audio track.
 * Concatenates silence + click sound segments using ffmpeg concat demuxer.
 */
export function generateClickSoundTrack(
  input: ClickSoundInput,
  tmpDir: string,
): string {
  const plan = buildClickSoundArgs(input)
  if (plan.filteredClicks.length === 0) return ''

  const segmentFiles: string[] = []

  for (let i = 0; i < plan.filteredClicks.length; i++) {
    const silenceMs = plan.silenceDurations[i]!

    // Add silence before this click
    if (silenceMs > 0) {
      const silencePath = path.join(tmpDir, `click-silence-${i}.mp3`)
      execFileSync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i',
        `anullsrc=r=44100:cl=mono,atrim=0:${(silenceMs / 1000).toFixed(3)}`,
        '-c:a', 'libmp3lame', '-q:a', '2', silencePath,
      ], { stdio: 'pipe' })
      segmentFiles.push(silencePath)
    }

    // Add click sound (with volume adjustment)
    if (Math.abs(input.volume - 1.0) > 0.01) {
      const volPath = path.join(tmpDir, `click-vol-${i}.mp3`)
      execFileSync('ffmpeg', [
        '-y', '-i', input.soundPath,
        '-af', `volume=${input.volume}`,
        '-c:a', 'libmp3lame', '-q:a', '2', volPath,
      ], { stdio: 'pipe' })
      segmentFiles.push(volPath)
    } else {
      segmentFiles.push(input.soundPath)
    }
  }

  // Concat all segments
  const concatList = path.join(tmpDir, 'click-concat.txt')
  fs.writeFileSync(concatList, segmentFiles.map(f => `file '${f}'`).join('\n'))

  execFileSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
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
