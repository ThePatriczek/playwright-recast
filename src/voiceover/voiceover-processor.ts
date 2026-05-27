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
  approachHolds: VoiceoverFreeze[] = [],
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
  // Capture each subtitle's pre-mutation start/end — these are the video
  // positions (in the speed-mapped timeline) where we may need to freeze
  // the frame so audio has time to finish. We freeze at the current
  // subtitle's window END (e.g. a waitForNarration() marker), not the next
  // subtitle's start: with waitForNarration() the window can close earlier
  // than the next narration begins, and the frame must hold at that point so
  // intervening visuals (clicks) don't play through before the audio ends.
  const originalStartsMs = trace.subtitles.map((s) => s.startMs)
  const originalEndsMs = trace.subtitles.map((s) => s.endMs)
  let cursor = 0
  let timeShift = 0

  // Approach holds (cursor-glide pauses at marked clicks) are interleaved with
  // the subtitles by position: each one drained below adds its duration to
  // timeShift — the subtitle's gap-fill silence then lengthens by exactly the
  // hold, keeping narration aligned — and is recorded as a freeze for the
  // renderer to apply to the video + click/cursor positions.
  const holds = [...approachHolds].sort((a, b) => a.atVideoMs - b.atVideoMs)
  let holdIndex = 0

  for (let si = 0; si < trace.subtitles.length; si++) {
    const subtitle = trace.subtitles[si]!
    const audio = audios[si]!

    while (holdIndex < holds.length && holds[holdIndex]!.atVideoMs <= originalStartsMs[si]!) {
      const h = holds[holdIndex]!
      freezes.push({ atVideoMs: h.atVideoMs, durationMs: h.durationMs })
      timeShift += h.durationMs
      holdIndex++
    }

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

    // A tiny/zero window (fast trace + waitForNarration, no autoWait) falls
    // through to the overflow branch below: the audio plays, the subtitle
    // stretches to the audio length, and a freeze is recorded at the window
    // end (the waitForNarration position). windowDuration is always >= 0 —
    // the builder clamps it and the loop shifts start/end by the same amount.
    if (audioDuration <= windowDuration) {
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
      // narration finishes before the next visual action starts. Hold at the
      // window END (originalEndsMs[si]) — for back-to-back narrations this
      // equals the next subtitle's start, but when waitForNarration() narrows
      // the window it closes earlier, and that earlier point is where the
      // pause belongs. The final segment has nothing after it to freeze
      // before; the renderer's end-of-video tpad handles its overflow instead.
      const nextOriginalStartMs = originalStartsMs[si + 1]
      if (nextOriginalStartMs !== undefined) {
        freezes.push({
          atVideoMs: originalEndsMs[si]!,
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

  // Holds after the last subtitle have no following narration to extend the
  // audio for; record them so the renderer still holds the video there.
  while (holdIndex < holds.length) {
    const h = holds[holdIndex]!
    freezes.push({ atVideoMs: h.atVideoMs, durationMs: h.durationMs })
    holdIndex++
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
