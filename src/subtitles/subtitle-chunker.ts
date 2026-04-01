import type { SubtitleEntry } from '../types/subtitle.js'

export interface ChunkOptions {
  /** Max characters per line before forcing a split (default: 60) */
  maxCharsPerLine?: number
  /** Min characters — don't create tiny fragments (default: 15) */
  minCharsPerChunk?: number
}

/**
 * Split subtitle entries into shorter, single-line chunks based on
 * punctuation. Time is distributed proportionally by character count.
 *
 * Splitting priority:
 *   1. Sentence boundaries: . ! ?
 *   2. Clause boundaries:   , ; : – —
 *   3. Word boundary (fallback if still too long)
 */
export function chunkSubtitles(
  entries: SubtitleEntry[],
  options?: ChunkOptions,
): SubtitleEntry[] {
  const maxChars = options?.maxCharsPerLine ?? 60
  const minChars = options?.minCharsPerChunk ?? 15

  const result: SubtitleEntry[] = []
  let globalIndex = 1

  for (const entry of entries) {
    const chunks = splitText(entry.text, maxChars, minChars)

    if (chunks.length <= 1) {
      result.push({ ...entry, index: globalIndex++ })
      continue
    }

    // Distribute time proportionally by character count
    const totalChars = chunks.reduce((sum, c) => sum + c.length, 0)
    const totalDuration = entry.endMs - entry.startMs
    let cursor = entry.startMs

    for (const chunk of chunks) {
      const ratio = chunk.length / totalChars
      const duration = totalDuration * ratio
      const endMs = cursor + duration

      result.push({
        index: globalIndex++,
        startMs: Math.round(cursor),
        endMs: Math.round(endMs),
        text: chunk,
        keyword: entry.keyword,
        zoom: entry.zoom,
      })

      cursor = endMs
    }
  }

  return result
}

/** Sentence-ending punctuation */
const SENTENCE_END = /([.!?])\s+/

/** Clause-boundary punctuation */
const CLAUSE_BREAK = /([,;:–—])\s+/

/**
 * Split text into chunks respecting punctuation boundaries.
 */
function splitText(text: string, maxChars: number, minChars: number): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return [trimmed]

  // Phase 1: Split on sentence boundaries
  let segments = splitOnPattern(trimmed, SENTENCE_END)

  // Phase 2: Further split long segments on clause boundaries
  segments = segments.flatMap((seg) =>
    seg.length > maxChars ? splitOnPattern(seg, CLAUSE_BREAK) : [seg],
  )

  // Phase 3: Split remaining long segments at word boundaries
  segments = segments.flatMap((seg) =>
    seg.length > maxChars ? splitAtWordBoundary(seg, maxChars) : [seg],
  )

  // Phase 4: Merge tiny fragments back into their neighbor
  return mergeSmallChunks(segments, minChars)
}

/**
 * Split text on a regex pattern, keeping the punctuation with the preceding chunk.
 */
function splitOnPattern(text: string, pattern: RegExp): string[] {
  const parts: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    const match = pattern.exec(remaining)
    if (!match || match.index === undefined) {
      parts.push(remaining.trim())
      break
    }

    // Include the punctuation mark with the preceding text
    const splitAt = match.index + match[1]!.length
    const before = remaining.slice(0, splitAt).trim()
    if (before) parts.push(before)

    remaining = remaining.slice(splitAt).trim()
  }

  return parts.filter((p) => p.length > 0)
}

/**
 * Split a long segment at the word boundary closest to the target length.
 */
function splitAtWordBoundary(text: string, maxChars: number): string[] {
  const results: string[] = []
  let remaining = text

  while (remaining.length > maxChars) {
    let splitAt = -1
    for (let i = maxChars; i >= 1; i--) {
      if (remaining[i] === ' ') {
        // Don't break after single-character words (typography: prepositions, conjunctions)
        if (i >= 1 && remaining[i - 1] !== ' ' && (i < 2 || remaining[i - 2] === ' ')) {
          continue
        }
        splitAt = i
        break
      }
    }

    if (splitAt === -1) {
      splitAt = maxChars
    }

    results.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }

  if (remaining.length > 0) {
    results.push(remaining)
  }

  return results
}

/**
 * Merge chunks shorter than minChars FORWARD into the next chunk.
 * Preserves sentence boundaries — small fragments get prepended
 * to the next clause, not appended to the previous sentence.
 */
function mergeSmallChunks(chunks: string[], minChars: number): string[] {
  if (chunks.length <= 1) return chunks

  const result: string[] = []
  let carry = ''

  for (const chunk of chunks) {
    if (carry) {
      result.push(carry + ' ' + chunk)
      carry = ''
    } else if (chunk.length < minChars) {
      carry = chunk
    } else {
      result.push(chunk)
    }
  }

  if (carry && result.length > 0) {
    result[result.length - 1] += ' ' + carry
  } else if (carry) {
    result.push(carry)
  }

  return result
}
