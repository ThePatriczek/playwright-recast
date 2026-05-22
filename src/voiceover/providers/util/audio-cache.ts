import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AudioSegment } from '../../../types/voiceover.js'
import { hashValues } from './hash.js'

/**
 * Disk cache for synthesized TTS audio.
 *
 * Cache key: SHA-256 over a provider-supplied fingerprint that captures every
 * input that influences the generated audio (text, voice, model, language,
 * provider-specific settings). The fingerprint MUST include the provider name
 * so caches from different providers don't collide in a shared directory.
 *
 * Cache layout: `<dir>/<hash>.<ext>`
 */
export interface AudioCacheConfig {
  /** Directory to store cached audio files. Created on demand. */
  dir: string
}

/**
 * One entry in the batch plan.
 *
 * - `hit`  → the cache had this file; `cachePath` exists and was copied to
 *            `ephemeralPath`.
 * - `miss` → first time we've seen this fingerprint in this batch; the caller
 *            must produce audio for `text` and write it via {@link writeMiss}.
 * - `dup`  → a previous entry in this batch already has the same fingerprint;
 *            after the canonical miss is written, `ephemeralPath` gets filled
 *            with a copy of the canonical's output.
 */
export interface BatchEntry {
  readonly index: number
  readonly text: string
  readonly hash: string
  readonly cachePath: string | null
  /** Final on-disk path for this entry (always inside the caller's workDir). */
  readonly ephemeralPath: string
  readonly kind: 'hit' | 'miss' | 'dup'
  /** For 'dup', the index of the canonical miss entry. */
  readonly canonicalIndex?: number
}

export interface BatchPlan {
  readonly entries: ReadonlyArray<BatchEntry>
  readonly missIndices: ReadonlyArray<number>
  readonly missTexts: ReadonlyArray<string>
}

interface PlanInput {
  texts: ReadonlyArray<string>
  workDir: string
  cache: AudioCacheConfig | undefined
  fingerprintFor: (text: string) => ReadonlyArray<string | number | boolean>
  prefix: string
  ext: string
}

/**
 * Partition `texts` into cache hits, fresh misses, and intra-batch duplicates.
 *
 * Side effects: ensures the cache directory exists (when caching) and copies
 * each cache hit into the caller's `workDir` so the resulting paths are
 * uniformly inside the caller's workspace (safe to rename/move).
 */
export function planBatch(input: PlanInput): BatchPlan {
  const { texts, workDir, cache, fingerprintFor, prefix, ext } = input
  if (cache) fs.mkdirSync(cache.dir, { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })

  const entries: BatchEntry[] = []
  const missIndices: number[] = []
  const missTexts: string[] = []
  const canonicalByHash = new Map<string, number>()

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!
    const hash = hashValues(fingerprintFor(text))
    const cachePath = cache ? path.join(cache.dir, `${hash}.${ext}`) : null
    const ephemeralPath = path.join(workDir, `${prefix}-${hash}-${i}.${ext}`)

    if (cachePath && fs.existsSync(cachePath)) {
      fs.copyFileSync(cachePath, ephemeralPath)
      entries.push({ index: i, text, hash, cachePath, ephemeralPath, kind: 'hit' })
      continue
    }

    const canonicalIndex = canonicalByHash.get(hash)
    if (canonicalIndex !== undefined) {
      entries.push({
        index: i, text, hash, cachePath, ephemeralPath,
        kind: 'dup', canonicalIndex,
      })
      continue
    }

    canonicalByHash.set(hash, i)
    missIndices.push(i)
    missTexts.push(text)
    entries.push({ index: i, text, hash, cachePath, ephemeralPath, kind: 'miss' })
  }

  return { entries, missIndices, missTexts }
}

/**
 * After the caller has produced audio for a miss, persist it:
 *  - if a cachePath is set, write to cache first, then copy to ephemeralPath
 *    (so subsequent EXDEV-safe renames in the caller can't destroy the cache)
 *  - otherwise write directly to ephemeralPath.
 */
export function writeMiss(entry: BatchEntry, data: Buffer): void {
  if (entry.kind !== 'miss') {
    throw new Error(`writeMiss called on a '${entry.kind}' entry (index ${entry.index})`)
  }
  if (entry.cachePath) {
    fs.mkdirSync(path.dirname(entry.cachePath), { recursive: true })
    fs.writeFileSync(entry.cachePath, data)
    fs.copyFileSync(entry.cachePath, entry.ephemeralPath)
  } else {
    fs.writeFileSync(entry.ephemeralPath, data)
  }
}

/**
 * After all misses have been written, copy each duplicate's ephemeralPath
 * from its canonical sibling. Each duplicate gets its own file so callers can
 * safely rename or move every path independently.
 */
export function fillDuplicates(plan: BatchPlan): void {
  const ephemeralByIndex = new Map<number, string>()
  for (const e of plan.entries) ephemeralByIndex.set(e.index, e.ephemeralPath)

  for (const e of plan.entries) {
    if (e.kind !== 'dup') continue
    const src = ephemeralByIndex.get(e.canonicalIndex!)
    if (!src) {
      throw new Error(`duplicate ${e.index} references missing canonical ${e.canonicalIndex}`)
    }
    fs.copyFileSync(src, e.ephemeralPath)
  }
}

export interface SynthesizeWithCacheOptions {
  texts: ReadonlyArray<string>
  workDir: string
  /** When undefined, the helper still does intra-batch dedup but no disk caching. */
  cache?: AudioCacheConfig
  /**
   * Per-text fingerprint. MUST include the provider name plus every input that
   * influences the audio (voice, model, language, settings, speed, etc.).
   * Anything left out causes silent cache-hit-but-wrong-audio bugs.
   */
  fingerprintFor: (text: string) => ReadonlyArray<string | number | boolean>
  /**
   * Generate audio for the miss texts (in order). The helper writes the
   * returned buffers to disk and into the cache.
   */
  generate: (missTexts: ReadonlyArray<string>) => Promise<ReadonlyArray<Buffer>>
  /** Filename prefix for ephemeral files in workDir. */
  prefix: string
  /** File extension + AudioSegment.format.codec. Default: 'mp3'. */
  ext?: string
  /** AudioSegment.format echoed onto every returned segment. */
  format: AudioSegment['format']
}

/**
 * High-level synthesis helper: handles cache lookup, fresh generation,
 * cache write, and intra-batch dedup. Returns one AudioSegment per input.
 */
export async function synthesizeWithCache(
  opts: SynthesizeWithCacheOptions,
): Promise<AudioSegment[]> {
  const ext = opts.ext ?? 'mp3'
  const plan = planBatch({
    texts: opts.texts,
    workDir: opts.workDir,
    cache: opts.cache,
    fingerprintFor: opts.fingerprintFor,
    prefix: opts.prefix,
    ext,
  })

  if (plan.missIndices.length > 0) {
    const buffers = await opts.generate(plan.missTexts)
    if (buffers.length !== plan.missTexts.length) {
      throw new Error(
        `generate() returned ${buffers.length} buffers for ${plan.missTexts.length} miss texts`,
      )
    }
    for (let k = 0; k < plan.missIndices.length; k++) {
      const entry = plan.entries[plan.missIndices[k]!]!
      writeMiss(entry, buffers[k]!)
    }
  }

  fillDuplicates(plan)

  return plan.entries.map((e) => ({
    path: e.ephemeralPath,
    durationMs: 0,
    format: opts.format,
  }))
}

/**
 * Convenience: deterministic ephemeral filename for callers that bypass
 * synthesizeWithCache but still want consistent naming.
 */
export function ephemeralName(prefix: string, ext = 'mp3'): string {
  return `${prefix}-${crypto.randomUUID()}.${ext}`
}
