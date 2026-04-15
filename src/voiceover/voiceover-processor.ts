import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { SubtitledTrace } from '../types/subtitle.js'
import type {
  TtsProvider,
  VoiceoveredTrace,
  VoiceoverEntry,
  VoiceoverOptions,
  LoudnessNormalizeConfig,
} from '../types/voiceover.js'
import { normalizeLoudness } from './normalize.js'

function getAudioDurationMs(filePath: string): number {
  const output = execFileSync('ffprobe', [
    '-v', 'quiet',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    filePath,
  ]).toString().trim()
  return Math.round(Number(output) * 1000)
}

function generateSilence(durationMs: number, outputPath: string, sampleRate = 24000): void {
  const durationSec = Math.max(0.01, durationMs / 1000)
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi',
    '-i', `anullsrc=r=${sampleRate}:cl=mono`,
    '-t', String(durationSec),
    '-c:a', 'libmp3lame', '-q:a', '9',
    outputPath,
  ], { stdio: 'pipe' })
}

/** Resolve normalize option to a concrete config or `null` (disabled). */
function resolveNormalize(
  opt: VoiceoverOptions['normalize'] | undefined,
): LoudnessNormalizeConfig | null {
  if (!opt) return null
  if (opt === true) return {}
  return opt
}

/**
 * Generate voiceover audio from subtitles using a TTS provider.
 * Produces individual audio segments, optionally normalizes loudness per segment,
 * pads with silence to match timing, and concatenates into a single audio track.
 */
export async function generateVoiceover(
  trace: SubtitledTrace,
  provider: TtsProvider,
  tmpDir: string,
  options?: VoiceoverOptions,
): Promise<VoiceoveredTrace> {
  fs.mkdirSync(tmpDir, { recursive: true })
  const normalizeConfig = resolveNormalize(options?.normalize)

  const entries: VoiceoverEntry[] = []
  const segmentFiles: string[] = []
  let cursor = 0
  let timeShift = 0

  for (let si = 0; si < trace.subtitles.length; si++) {
    const subtitle = trace.subtitles[si]!

    subtitle.startMs += timeShift
    subtitle.endMs += timeShift

    if (subtitle.startMs > cursor) {
      const silencePath = path.join(tmpDir, `silence-${subtitle.index}.mp3`)
      generateSilence(subtitle.startMs - cursor, silencePath)
      segmentFiles.push(silencePath)
    }

    // Synthesize raw TTS into a staging file, then (optionally) normalize into
    // the canonical seg-N.mp3 path that gets concatenated.
    const segPath = path.join(tmpDir, `seg-${subtitle.index}.mp3`)
    const audio = await provider.synthesize(subtitle.ttsText ?? subtitle.text)

    if (normalizeConfig) {
      const rawPath = path.join(tmpDir, `raw-${subtitle.index}.mp3`)
      fs.writeFileSync(rawPath, audio.data)
      await normalizeLoudness(rawPath, segPath, normalizeConfig)
    } else {
      fs.writeFileSync(segPath, audio.data)
    }

    const audioDuration = getAudioDurationMs(segPath)
    const windowDuration = subtitle.endMs - subtitle.startMs

    if (windowDuration < 100) {
      cursor = subtitle.endMs
    } else if (audioDuration <= windowDuration) {
      segmentFiles.push(segPath)
      const pad = windowDuration - audioDuration
      if (pad > 50) {
        const padPath = path.join(tmpDir, `pad-${subtitle.index}.mp3`)
        generateSilence(pad, padPath)
        segmentFiles.push(padPath)
      }
      cursor = subtitle.endMs
    } else {
      const overflow = audioDuration - windowDuration
      segmentFiles.push(segPath)
      subtitle.endMs = subtitle.startMs + audioDuration
      timeShift += overflow
      cursor = subtitle.endMs
    }

    entries.push({
      subtitle,
      audio,
      outputStartMs: subtitle.startMs,
      outputEndMs: subtitle.endMs,
    })
  }

  const concatList = path.join(tmpDir, 'concat.txt')
  fs.writeFileSync(
    concatList,
    segmentFiles.map((f) => `file '${path.basename(f)}'`).join('\n'),
  )

  const audioTrackPath = path.join(tmpDir, 'voiceover.mp3')
  if (segmentFiles.length > 0) {
    execFileSync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', concatList,
      '-c', 'copy',
      audioTrackPath,
    ], { stdio: 'pipe' })
  }

  const totalDurationMs = segmentFiles.length > 0
    ? getAudioDurationMs(audioTrackPath)
    : 0

  return {
    ...trace,
    voiceover: {
      entries,
      audioTrackPath,
      totalDurationMs,
    },
  }
}
