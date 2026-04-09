import * as fs from 'node:fs'
import * as path from 'node:path'
import { writeSrt } from '../subtitles/srt-writer.js'
import type { SubtitleEntry } from '../types/subtitle.js'

interface StepInput {
  id: string
  hidden: boolean
  startTimeMs: number
  endTimeMs: number
  voiceover?: string
}

const LAST_ENTRY_EXTENSION_MS = 5000

export function buildSrtFromSteps(steps: StepInput[]): string {
  const entries: SubtitleEntry[] = []
  let index = 1

  const visibleWithVoiceover = steps.filter((s) => !s.hidden && s.voiceover && s.voiceover.trim().length > 0)

  for (let i = 0; i < visibleWithVoiceover.length; i++) {
    const step = visibleWithVoiceover[i]!
    const isLast = i === visibleWithVoiceover.length - 1

    entries.push({
      index: index++,
      startMs: step.startTimeMs,
      endMs: isLast ? step.startTimeMs + LAST_ENTRY_EXTENSION_MS : step.endTimeMs,
      text: step.voiceover!.trim(),
    })
  }

  return writeSrt(entries)
}

export function writeSrtFile(traceDir: string, steps: StepInput[]): string {
  const srt = buildSrtFromSteps(steps)
  const srtPath = path.join(traceDir, 'voiceover.srt')
  fs.writeFileSync(srtPath, srt, 'utf-8')
  return srtPath
}
