import { execFileSync } from 'node:child_process'

/** The two properties the concat demuxer requires to match across inputs. */
export interface AudioFormat {
  sampleRate: number
  channels: number
}

/** Probe one audio file. Returns null when ffprobe cannot read it. */
export function probeAudioFormat(filePath: string): AudioFormat | null {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels',
      '-of', 'csv=p=0', filePath,
    ]).toString().trim()
    const [rateStr, chStr] = out.split(',')
    const sampleRate = Number(rateStr)
    const channels = Number(chStr)
    if (!Number.isFinite(sampleRate) || !Number.isFinite(channels)) return null
    if (sampleRate <= 0 || channels <= 0) return null
    return { sampleRate, channels }
  } catch {
    return null
  }
}

/**
 * Decide how to concatenate TTS segments.
 *
 * Stream copy is kept whenever every segment already agrees — that is the
 * common case, and re-encoding it would change audio for pipelines that are
 * working today. Only a genuine mismatch, which the concat demuxer would
 * otherwise resolve by silently keeping the first segment's format and playing
 * the rest at the wrong rate, triggers a normalising encode.
 *
 * A failed probe counts as a mismatch: without proof that the formats agree,
 * normalising is the safe branch.
 */
export function planAudioConcat(
  formats: Array<AudioFormat | null>,
): { normalise: false } | { normalise: true; sampleRate: number; channels: number } {
  if (formats.length <= 1) return { normalise: false }
  if (formats.some((f) => f === null)) {
    return { normalise: true, sampleRate: 44100, channels: 1 }
  }

  const known = formats as AudioFormat[]
  const first = known[0]!
  const allAgree = known.every(
    (f) => f.sampleRate === first.sampleRate && f.channels === first.channels,
  )
  if (allAgree) return { normalise: false }

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
  if (bestKey === null || tied) return { normalise: true, sampleRate: 44100, channels: 1 }

  const [rate, ch] = bestKey.split(':')
  return { normalise: true, sampleRate: Number(rate), channels: Number(ch) }
}
