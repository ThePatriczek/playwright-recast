import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Sample rate and channel count of an audio file. */
export interface AudioFormat {
  sampleRate: number
  channels: number
}

/** Probe one audio file. Null when ffprobe cannot read it. */
export async function probeAudioFormat(filePath: string): Promise<AudioFormat | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels',
      '-of', 'csv=p=0', filePath,
    ])
    const [sampleRate, channels] = stdout.trim().split(',').map(Number)
    if (!(sampleRate! > 0) || !(channels! > 0)) return null
    return { sampleRate: sampleRate!, channels: channels! }
  } catch {
    return null
  }
}

/**
 * The format to join TTS segments in: theirs when they agree, else the most
 * common one (`mismatch`), so the fewest segments are resampled. Failed
 * probes do not vote; with none known, a common format is the safe choice.
 */
export function planAudioConcat(
  formats: Array<AudioFormat | null>,
): AudioFormat & { mismatch: boolean } {
  const known = formats.filter((f): f is AudioFormat => f !== null)
  const fallback = { sampleRate: 44100, channels: 1, mismatch: known.length > 1 }
  if (known.length === 0) return { ...fallback, mismatch: false }

  const first = known[0]!
  const allAgree = known.every(
    (f) => f.sampleRate === first.sampleRate && f.channels === first.channels,
  )
  if (allAgree) return { sampleRate: first.sampleRate, channels: first.channels, mismatch: false }

  // Pick the most common (rate, channels) pair; ties fall back to 44.1kHz mono.
  const counts = new Map<string, number>()
  for (const f of known) {
    const key = `${f.sampleRate}:${f.channels}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let bestKey: string | null = null
  let bestCount = 0
  let tied = false
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key
      bestCount = count
      tied = false
    } else if (count === bestCount) {
      tied = true
    }
  }
  if (bestKey === null || tied) return fallback

  const [rate, ch] = bestKey.split(':')
  return { sampleRate: Number(rate), channels: Number(ch), mismatch: true }
}
