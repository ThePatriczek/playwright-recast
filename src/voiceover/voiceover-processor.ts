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

  for (const subtitle of trace.subtitles) {
    // Insert silence for gap before this segment
    if (subtitle.startMs > cursor) {
      const silencePath = path.join(tmpDir, `silence-${subtitle.index}.mp3`)
      generateSilence(subtitle.startMs - cursor, silencePath)
      segmentFiles.push(silencePath)
    }

    // Generate TTS
    const segPath = path.join(tmpDir, `seg-${subtitle.index}.mp3`)
    const audio = await provider.synthesize(subtitle.text)
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
      // Audio overflows the window. Strategy:
      // 1. Speed up slightly (max 1.4x) to keep natural sound
      // 2. Then TRUNCATE to fit the window exactly
      // This ensures perfect sync — no overflow cascading to later subtitles.
      const speedFactor = Math.min(1.4, audioDuration / windowDuration)
      let inputFile = segPath

      if (speedFactor > 1.01) {
        const fittedPath = path.join(tmpDir, `fitted-${subtitle.index}.mp3`)
        execFileSync('ffmpeg', [
          '-y', '-i', segPath,
          '-filter:a', `atempo=${speedFactor.toFixed(4)}`,
          '-c:a', 'libmp3lame', '-q:a', '2',
          fittedPath,
        ], { stdio: 'pipe' })
        inputFile = fittedPath
      }

      // Truncate to window duration (hard cut ensures sync)
      const truncPath = path.join(tmpDir, `trunc-${subtitle.index}.mp3`)
      const windowSec = Math.max(0.1, windowDuration / 1000)
      execFileSync('ffmpeg', [
        '-y', '-i', inputFile,
        '-t', windowSec.toFixed(3),
        // Fade out the last 200ms to avoid harsh cut
        '-af', `afade=t=out:st=${Math.max(0, windowSec - 0.2).toFixed(3)}:d=0.2`,
        '-c:a', 'libmp3lame', '-q:a', '2',
        truncPath,
      ], { stdio: 'pipe' })
      segmentFiles.push(truncPath)

      const truncDuration = getAudioDurationMs(truncPath)
      const pad = windowDuration - truncDuration
      if (pad > 50) {
        const padPath = path.join(tmpDir, `pad-${subtitle.index}.mp3`)
        generateSilence(pad, padPath)
        segmentFiles.push(padPath)
      }
      cursor = subtitle.endMs
    }

    entries.push({
      subtitle,
      audio,
      outputStartMs: subtitle.startMs,
      outputEndMs: Math.max(subtitle.endMs, subtitle.startMs + audioDuration),
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
      '-c:a', 'libmp3lame', '-q:a', '2',
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
