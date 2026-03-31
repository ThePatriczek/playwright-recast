import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { SubtitledTrace } from '../types/subtitle.js'
import type { TtsProvider, VoiceoveredTrace, VoiceoverEntry } from '../types/voiceover.js'

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

/**
 * Generate voiceover audio from subtitles using a TTS provider.
 * Produces individual audio segments, pads with silence to match timing,
 * and concatenates into a single audio track.
 */
export async function generateVoiceover(
  trace: SubtitledTrace,
  provider: TtsProvider,
  tmpDir: string,
): Promise<VoiceoveredTrace> {
  fs.mkdirSync(tmpDir, { recursive: true })

  const entries: VoiceoverEntry[] = []
  const segmentFiles: string[] = []
  let cursor = 0
  let timeShift = 0 // cumulative shift from TTS overflows

  for (let si = 0; si < trace.subtitles.length; si++) {
    const subtitle = trace.subtitles[si]!

    // Apply accumulated time shift from previous overflows
    subtitle.startMs += timeShift
    subtitle.endMs += timeShift

    // Insert silence for gap before this segment
    if (subtitle.startMs > cursor) {
      const silencePath = path.join(tmpDir, `silence-${subtitle.index}.mp3`)
      generateSilence(subtitle.startMs - cursor, silencePath)
      segmentFiles.push(silencePath)
    }

    // Generate TTS (use processed text if available, original otherwise)
    const segPath = path.join(tmpDir, `seg-${subtitle.index}.mp3`)
    const audio = await provider.synthesize(subtitle.ttsText ?? subtitle.text)
    fs.writeFileSync(segPath, audio.data)

    const audioDuration = getAudioDurationMs(segPath)
    const windowDuration = subtitle.endMs - subtitle.startMs

    if (windowDuration < 100) {
      // Window too short — skip audio for this subtitle
      cursor = subtitle.endMs
    } else if (audioDuration <= windowDuration) {
      // Audio fits — add padding silence to fill the window
      segmentFiles.push(segPath)
      const pad = windowDuration - audioDuration
      if (pad > 50) {
        const padPath = path.join(tmpDir, `pad-${subtitle.index}.mp3`)
        generateSilence(pad, padPath)
        segmentFiles.push(padPath)
      }
      cursor = subtitle.endMs
    } else {
      // Audio overflows the window — play at raw speed (never modify TTS tempo).
      // Extend this subtitle and shift all subsequent subtitles forward.
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

  // Concat all segments into single audio track
  const concatList = path.join(tmpDir, 'concat.txt')
  fs.writeFileSync(
    concatList,
    segmentFiles.map((f) => `file '${f}'`).join('\n'),
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
