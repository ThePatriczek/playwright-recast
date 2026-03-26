import type { SubtitleEntry } from '../types/subtitle.js'

function formatSrtTime(ms: number): string {
  const rounded = Math.round(ms)
  const totalSeconds = Math.floor(rounded / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const millis = rounded % 1000

  return (
    [
      String(hours).padStart(2, '0'),
      String(minutes).padStart(2, '0'),
      String(seconds).padStart(2, '0'),
    ].join(':') +
    ',' +
    String(millis).padStart(3, '0')
  )
}

/** Write subtitle entries to SRT format string */
export function writeSrt(entries: SubtitleEntry[]): string {
  if (entries.length === 0) return ''

  return entries
    .map((entry) => {
      const start = formatSrtTime(entry.startMs)
      const end = formatSrtTime(entry.endMs)
      return `${entry.index}\n${start} --> ${end}\n${entry.text}`
    })
    .join('\n\n')
    .concat('\n')
}
