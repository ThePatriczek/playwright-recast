import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { SubtitledTrace } from '../types/subtitle.js'
import type {
  TtsProvider,
  VoiceoveredTrace,
  VoiceoverEntry,
  VoiceoverFreeze,
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

  if (!(await provider.isAvailable())) {
    throw new Error(
      `Voiceover provider "${provider.name}" is not available — ` +
        `check credentials, peer-dependency installation, or runtime prerequisites.`,
    )
  }

  const texts = trace.subtitles.map((s) => s.ttsText ?? s.text)
  const audios = await provider.synthesize(texts, { workDir: tmpDir })

  if (audios.length !== texts.length) {
    throw new Error(
      `Provider "${provider.name}" returned ${audios.length} segments for ${texts.length} texts`,
    )
  }

  const entries: VoiceoverEntry[] = []
  const segmentFiles: string[] = []
  const freezes: VoiceoverFreeze[] = []
  // Capture each subtitle's pre-mutation startMs — these are the video
  // positions (in the speed-mapped timeline) where we may need to freeze
  // the frame so audio has time to finish.
  const originalStartsMs = trace.subtitles.map((s) => s.startMs)
  let cursor = 0
  let timeShift = 0

  for (let si = 0; si < trace.subtitles.length; si++) {
    const subtitle = trace.subtitles[si]!
    const audio = audios[si]!

    subtitle.startMs += timeShift
    subtitle.endMs += timeShift
    if (subtitle.zoom?.startMs !== undefined) subtitle.zoom.startMs += timeShift
    if (subtitle.zoom?.endMs !== undefined) subtitle.zoom.endMs += timeShift

    if (subtitle.startMs > cursor) {
      const silencePath = path.join(tmpDir, `silence-${subtitle.index}.mp3`)
      generateSilence(subtitle.startMs - cursor, silencePath)
      segmentFiles.push(silencePath)
    }

    const segPath = path.join(tmpDir, `seg-${subtitle.index}.mp3`)
    if (normalizeConfig) {
      await normalizeLoudness(audio.path, segPath, normalizeConfig)
    } else {
      // Move (rename) the provider's output into the canonical seg-N.mp3 slot.
      // Falls back to copy+unlink across devices.
      try {
        fs.renameSync(audio.path, segPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        fs.copyFileSync(audio.path, segPath)
        fs.unlinkSync(audio.path)
      }
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
      // Freeze the video on the last frame of this segment's window so the
      // narration finishes before the next visual action starts. The final
      // segment has nothing to freeze against; the renderer's end-of-video
      // tpad handles its overflow instead.
      const nextOriginalStartMs = originalStartsMs[si + 1]
      if (nextOriginalStartMs !== undefined) {
        freezes.push({
          atVideoMs: nextOriginalStartMs,
          durationMs: overflow,
        })
      }
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
      freezes,
    },
  }
}
