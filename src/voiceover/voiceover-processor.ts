import * as fs from 'node:fs'
import * as path from 'node:path'
import { planAudioConcat, probeAudioFormat } from './audio-format.js'
import type { SubtitledTrace } from '../types/subtitle.js'
import type {
  TtsProvider,
  VoiceoveredTrace,
  VoiceoverEntry,
  VoiceoverFreeze,
  VoiceoverOptions,
  LoudnessNormalizeConfig,
} from '../types/voiceover.js'
import { normalizeLoudness, NORMALIZE_SAMPLE_RATE } from './normalize.js'
import { WavWriter } from './wav.js'
import { runFfmpegAsync } from '../utils/ffmpeg.js'
import { alignFreezeToFrame, alignNarrationHold } from './frame-align.js'

/**
 * `fn` over `items`, at most `limit` at a time, results in order. After a
 * failure no new item starts, and running ones finish before the first
 * error is thrown, so no ffmpeg outlives the call.
 */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let failure: { error: unknown } | undefined
  const worker = async (): Promise<void> => {
    while (!failure && next < items.length) {
      const i = next++
      try {
        results[i] = await fn(items[i]!, i)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure) throw failure.error
  return results
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
 * @param outputFps Frame rate of the rendered output. Freeze points are
 *   aligned to it here — once — so the audio silence, the subtitle shift, and
 *   the renderer's video hold all use identical numbers. Aligning downstream
 *   instead would leave shiftForFreezes() on raw milliseconds while the video
 *   held frame-rounded ones, desyncing every click and cursor keyframe.
 */
export async function generateVoiceover(
  trace: SubtitledTrace,
  provider: TtsProvider,
  tmpDir: string,
  options: VoiceoverOptions | undefined,
  approachHolds: VoiceoverFreeze[] = [],
  outputFps: number,
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
  // Private: tmpDir is reused across runs, and a provider's file names must
  // not collide with the track's. Files outside it (a cache) are the provider's.
  const workDir = fs.mkdtempSync(path.join(tmpDir, 'recast-vo-'))
  const ttsDir = path.join(workDir, 'tts')
  fs.mkdirSync(ttsDir)
  const segPathFor = (si: number): string => path.join(workDir, `seg-${si}.wav`)
  try {
    const audios = await provider.synthesize(texts, { workDir: ttsDir })
    if (audios.length !== texts.length) {
      throw new Error(
        `Provider "${provider.name}" returned ${audios.length} segments for ${texts.length} texts`,
      )
    }
    // Every segment becomes 16-bit PCM in one format, so the track is written
    // sample by sample and every duration is a sample count. Files are keyed
    // by position: SRT indexes can repeat.
    let format: { sampleRate: number; channels: number }
    if (normalizeConfig) {
      // normalize writes 16-bit PCM, mono, at its own rate
      format = { sampleRate: normalizeConfig.sampleRate ?? NORMALIZE_SAMPLE_RATE, channels: 1 }
      await mapWithLimit(audios, 4, (audio, si) => normalizeLoudness(audio.path, segPathFor(si), normalizeConfig))
    } else {
      const plan = planAudioConcat(await mapWithLimit(audios, 4, (audio) => probeAudioFormat(audio.path)))
      if (plan.mismatch) {
        console.log(`  Voiceover: segment formats differ - resampling to ${plan.sampleRate}Hz/${plan.channels}ch`)
      }
      format = plan
      await mapWithLimit(audios, 4, (audio, si) =>
        runFfmpegAsync(['-y', '-v', 'error', '-i', audio.path, '-c:a', 'pcm_s16le', '-ar', String(plan.sampleRate), '-ac', String(plan.channels), segPathFor(si)]))
    }
    const toMs = (samples: number): number => (samples * 1000) / format.sampleRate
    const toSamples = (ms: number): number => Math.max(0, Math.round((ms * format.sampleRate) / 1000))
    const audioTrackPath = path.join(tmpDir, 'voiceover.wav')
    const track = new WavWriter(audioTrackPath, format.sampleRate, format.channels)

    const entries: VoiceoverEntry[] = []
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
    let timeShift = 0
    /** Where the track ends, in whole samples: a gap's rounding is absorbed by the next. */
    let audioEndMs = 0

    // Approach holds (cursor-glide pauses at marked clicks) are interleaved with
    // the subtitles by position: each one drained below adds its duration to
    // timeShift — the subtitle's gap-fill silence then lengthens by exactly the
    // hold, keeping narration aligned — and is recorded as a freeze for the
    // renderer to apply to the video + click/cursor positions.
    const holds = [...approachHolds].sort((a, b) => a.atVideoMs - b.atVideoMs)
    let holdIndex = 0

    try {
      for (let si = 0; si < trace.subtitles.length; si++) {
        const subtitle = trace.subtitles[si]!
        const audio = audios[si]!

        while (holdIndex < holds.length && holds[holdIndex]!.atVideoMs <= originalStartsMs[si]!) {
          const h = holds[holdIndex]!
          const aligned = alignFreezeToFrame(h.atVideoMs, h.durationMs, outputFps, h.sourceMs)
          freezes.push(aligned)
          timeShift += aligned.durationMs
          holdIndex++
        }

        subtitle.startMs += timeShift
        subtitle.endMs += timeShift
        if (subtitle.zoom?.startMs !== undefined) subtitle.zoom.startMs += timeShift
        if (subtitle.zoom?.endMs !== undefined) subtitle.zoom.endMs += timeShift

        // Fill from where the track really ends up to this cue's start.
        const gapMs = subtitle.startMs - audioEndMs
        if (gapMs > 0) track.silence(toSamples(gapMs))
        audioEndMs = toMs(track.samples)

        const audioDuration = toMs(track.append(segPathFor(si)))
        const windowDuration = subtitle.endMs - subtitle.startMs
        // Where the track really is, not the cue start: the gap above can over- or undershoot.
        const spokenEndMs = audioEndMs + audioDuration

        // A tiny/zero window (fast trace + waitForNarration, no autoWait) falls
        // through to the overflow branch below: the audio plays, the subtitle
        // stretches to the audio length, and a freeze is recorded at the window
        // end (the waitForNarration position). windowDuration is always >= 0 —
        // the builder clamps it and the loop shifts start/end by the same amount.
        if (audioDuration <= windowDuration) {
          const pad = windowDuration - audioDuration
          track.silence(toSamples(pad))
        } else {
          const overflow = audioDuration - windowDuration
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
            // Rounds up: a short hold leaves captions ahead of the voice.
            const aligned = alignNarrationHold(originalEndsMs[si]!, overflow, outputFps)
            const endTraceMs = trace.subtitles[si]!.endTraceMs
            freezes.push(endTraceMs !== undefined ? { ...aligned, sourceTraceMs: endTraceMs } : aligned)
            timeShift += aligned.durationMs
          } else {
            timeShift += overflow
          }
        }
        audioEndMs = toMs(track.samples)

        entries.push({
          subtitle,
          audio,
          outputStartMs: subtitle.startMs,
          outputEndMs: subtitle.endMs,
          spokenEndMs,
        })
      }

      // Holds after the last subtitle have no following narration to extend the
      // audio for; record them so the renderer still holds the video there.
      while (holdIndex < holds.length) {
        const h = holds[holdIndex]!
        freezes.push(alignFreezeToFrame(h.atVideoMs, h.durationMs, outputFps, h.sourceMs))
        holdIndex++
      }
      track.close()
    } catch (error) {
      track.abort()
      throw error
    }
    const totalDurationMs = Math.round(toMs(track.samples))
    // No narration: no file, which is how the renderer tells
    if (track.samples === 0) fs.rmSync(audioTrackPath, { force: true })

    return {
      ...trace,
      voiceover: {
        entries,
        audioTrackPath,
        totalDurationMs,
        freezes,
      },
    }
  } finally {
    // A locked file must not fail a finished voiceover
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* left behind */ }
  }
}
