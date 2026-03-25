import type { SubtitleEntry } from '../types/subtitle.js'

function parseSrtTime(time: string): number {
  const parts = time.split(':')
  const [s, ms] = (parts[2] ?? '0,0').split(',')
  return (
    Number(parts[0]) * 3600_000 +
    Number(parts[1]) * 60_000 +
    Number(s) * 1000 +
    Number(ms)
  )
}

/** Parse an SRT string into SubtitleEntry[] */
export function parseSrt(content: string): SubtitleEntry[] {
  const blocks = content.trim().split(/\n\n+/)
  if (!blocks[0]?.trim()) return []

  return blocks.map((block) => {
    const lines = block.split('\n')
    const index = Number(lines[0])
    const timeLine = lines[1] ?? ''
    const [startStr = '0:0:0,0', endStr = '0:0:0,0'] = timeLine.split(' --> ')
    const text = lines.slice(2).join('\n').trim()
    return {
      index,
      startMs: parseSrtTime(startStr),
      endMs: parseSrtTime(endStr),
      text,
    }
  })
}
