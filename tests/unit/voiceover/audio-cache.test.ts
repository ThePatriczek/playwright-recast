import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { synthesizeWithCache, planBatch, writeMiss, fillDuplicates } from '../../../src/voiceover/providers/util/audio-cache'

const TMP_ROOT = path.join(os.tmpdir(), `recast-audio-cache-test-${process.pid}`)

beforeAll(() => fs.mkdirSync(TMP_ROOT, { recursive: true }))
afterAll(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }))

function makeWorkAndCache(label: string): { workDir: string; cacheDir: string } {
  const root = path.join(TMP_ROOT, label)
  const workDir = path.join(root, 'work')
  const cacheDir = path.join(root, 'cache')
  fs.mkdirSync(workDir, { recursive: true })
  return { workDir, cacheDir }
}

function fakeAudio(text: string): Buffer {
  return Buffer.from(`audio:${text}`)
}

describe('synthesizeWithCache', () => {
  let calls: number
  let lastTexts: ReadonlyArray<string>

  beforeEach(() => {
    calls = 0
    lastTexts = []
  })

  const fingerprintFor = (text: string) => ['testprov', text, 'voice-a', 'model-a']
  const format = { sampleRate: 24000, channels: 1 as const, codec: 'mp3' }

  async function generate(texts: ReadonlyArray<string>): Promise<Buffer[]> {
    calls++
    lastTexts = texts
    return texts.map(fakeAudio)
  }

  it('passes all texts to generate() on first call (cache empty)', async () => {
    const { workDir, cacheDir } = makeWorkAndCache('first-call')

    const result = await synthesizeWithCache({
      texts: ['alpha', 'beta', 'gamma'],
      workDir,
      cache: { dir: cacheDir },
      fingerprintFor,
      generate,
      prefix: 'testprov',
      format,
    })

    expect(calls).toBe(1)
    expect(lastTexts).toEqual(['alpha', 'beta', 'gamma'])
    expect(result).toHaveLength(3)
    for (const seg of result) {
      expect(fs.existsSync(seg.path)).toBe(true)
      expect(seg.format).toEqual(format)
    }
    // Cache files should now exist
    expect(fs.readdirSync(cacheDir).length).toBe(3)
  })

  it('serves all from disk cache on a second identical call (zero generate invocations)', async () => {
    const { workDir, cacheDir } = makeWorkAndCache('second-call')

    await synthesizeWithCache({
      texts: ['alpha', 'beta'],
      workDir,
      cache: { dir: cacheDir },
      fingerprintFor,
      generate,
      prefix: 'testprov',
      format,
    })

    calls = 0
    lastTexts = []
    const result = await synthesizeWithCache({
      texts: ['alpha', 'beta'],
      workDir,
      cache: { dir: cacheDir },
      fingerprintFor,
      generate,
      prefix: 'testprov',
      format,
    })

    expect(calls).toBe(0)
    expect(result).toHaveLength(2)
    for (const seg of result) {
      expect(fs.existsSync(seg.path)).toBe(true)
      expect(fs.readFileSync(seg.path).toString().startsWith('audio:')).toBe(true)
    }
  })

  it('only calls generate() with the texts that miss the cache', async () => {
    const { workDir, cacheDir } = makeWorkAndCache('partial-hit')

    await synthesizeWithCache({
      texts: ['alpha'],
      workDir,
      cache: { dir: cacheDir },
      fingerprintFor,
      generate,
      prefix: 'testprov',
      format,
    })

    calls = 0
    lastTexts = []
    await synthesizeWithCache({
      texts: ['alpha', 'beta', 'gamma'],
      workDir,
      cache: { dir: cacheDir },
      fingerprintFor,
      generate,
      prefix: 'testprov',
      format,
    })

    expect(calls).toBe(1)
    expect(lastTexts).toEqual(['beta', 'gamma'])
  })

  it('dedups identical texts within a batch (one generate call per unique text)', async () => {
    const { workDir, cacheDir } = makeWorkAndCache('intra-batch-dedup')

    const result = await synthesizeWithCache({
      texts: ['x', 'y', 'x', 'y', 'x'],
      workDir,
      cache: { dir: cacheDir },
      fingerprintFor,
      generate,
      prefix: 'testprov',
      format,
    })

    expect(calls).toBe(1)
    expect(lastTexts).toEqual(['x', 'y']) // only unique misses
    expect(result).toHaveLength(5)
    // Each duplicate gets its own ephemeral file
    const paths = result.map((r) => r.path)
    expect(new Set(paths).size).toBe(5)
    // Content must match per text
    expect(fs.readFileSync(result[0].path).toString()).toBe('audio:x')
    expect(fs.readFileSync(result[2].path).toString()).toBe('audio:x')
    expect(fs.readFileSync(result[4].path).toString()).toBe('audio:x')
    expect(fs.readFileSync(result[1].path).toString()).toBe('audio:y')
    expect(fs.readFileSync(result[3].path).toString()).toBe('audio:y')
  })

  it('does intra-batch dedup even when disk cache is disabled', async () => {
    const { workDir } = makeWorkAndCache('no-cache-dedup')

    const result = await synthesizeWithCache({
      texts: ['x', 'x', 'y'],
      workDir,
      cache: undefined,
      fingerprintFor,
      generate,
      prefix: 'testprov',
      format,
    })

    expect(calls).toBe(1)
    expect(lastTexts).toEqual(['x', 'y'])
    expect(result).toHaveLength(3)
    expect(fs.readFileSync(result[0].path).toString()).toBe('audio:x')
    expect(fs.readFileSync(result[1].path).toString()).toBe('audio:x')
    expect(fs.readFileSync(result[2].path).toString()).toBe('audio:y')
  })

  it('different fingerprints (e.g. different voices) are independent cache entries', async () => {
    const { workDir, cacheDir } = makeWorkAndCache('fingerprint-sensitivity')

    // First call: voice-a
    await synthesizeWithCache({
      texts: ['hello'],
      workDir, cache: { dir: cacheDir },
      fingerprintFor: (t) => ['testprov', t, 'voice-a'],
      generate, prefix: 'testprov', format,
    })

    calls = 0
    // Second call: voice-b — must miss cache, call generate
    await synthesizeWithCache({
      texts: ['hello'],
      workDir, cache: { dir: cacheDir },
      fingerprintFor: (t) => ['testprov', t, 'voice-b'],
      generate, prefix: 'testprov', format,
    })

    expect(calls).toBe(1)
    expect(fs.readdirSync(cacheDir).length).toBe(2) // two different hashes
  })

  it('throws when generate() returns fewer buffers than miss texts', async () => {
    const { workDir, cacheDir } = makeWorkAndCache('length-mismatch')

    const wrongGenerate = async (texts: ReadonlyArray<string>) =>
      [Buffer.from('x')] // always one regardless of input

    await expect(
      synthesizeWithCache({
        texts: ['a', 'b', 'c'],
        workDir,
        cache: { dir: cacheDir },
        fingerprintFor,
        generate: wrongGenerate,
        prefix: 'testprov',
        format,
      }),
    ).rejects.toThrow(/returned 1 buffers for 3 miss texts/)
  })

  it('cache hit content equals the originally generated buffer', async () => {
    const { workDir, cacheDir } = makeWorkAndCache('content-fidelity')

    await synthesizeWithCache({
      texts: ['hello'],
      workDir, cache: { dir: cacheDir },
      fingerprintFor, generate, prefix: 'testprov', format,
    })

    const result = await synthesizeWithCache({
      texts: ['hello'],
      workDir, cache: { dir: cacheDir },
      fingerprintFor, generate, prefix: 'testprov', format,
    })

    expect(fs.readFileSync(result[0].path)).toEqual(fakeAudio('hello'))
  })
})

describe('planBatch primitive', () => {
  const fingerprintFor = (text: string) => ['testprov', text]

  it('classifies entries as hit / miss / dup correctly', () => {
    const { workDir, cacheDir } = makeWorkAndCache('plan-classify')
    fs.mkdirSync(cacheDir, { recursive: true })
    // Pre-seed cache with one hash so 'cached' is a hit
    const seedPlan = planBatch({
      texts: ['cached'],
      workDir,
      cache: { dir: cacheDir },
      fingerprintFor, prefix: 'p', ext: 'mp3',
    })
    writeMiss(seedPlan.entries[0]!, Buffer.from('PRE'))

    const plan = planBatch({
      texts: ['cached', 'fresh', 'fresh'],
      workDir,
      cache: { dir: cacheDir },
      fingerprintFor, prefix: 'p', ext: 'mp3',
    })

    expect(plan.entries.map((e) => e.kind)).toEqual(['hit', 'miss', 'dup'])
    expect(plan.missIndices).toEqual([1])
    expect(plan.missTexts).toEqual(['fresh'])
    expect(plan.entries[2]!.canonicalIndex).toBe(1)
  })

  it('fillDuplicates copies canonical to dup paths', () => {
    const { workDir, cacheDir } = makeWorkAndCache('plan-dup-fill')
    fs.mkdirSync(cacheDir, { recursive: true })

    const plan = planBatch({
      texts: ['same', 'same'],
      workDir,
      cache: { dir: cacheDir },
      fingerprintFor, prefix: 'p', ext: 'mp3',
    })

    writeMiss(plan.entries[0]!, Buffer.from('CANON'))
    fillDuplicates(plan)

    expect(fs.readFileSync(plan.entries[1]!.ephemeralPath).toString()).toBe('CANON')
    // Distinct files — caller can rename one without affecting the other
    expect(plan.entries[0]!.ephemeralPath).not.toBe(plan.entries[1]!.ephemeralPath)
  })

  it('writeMiss on a non-miss entry throws', () => {
    const { workDir, cacheDir } = makeWorkAndCache('writeMiss-guard')
    fs.mkdirSync(cacheDir, { recursive: true })

    const seed = planBatch({
      texts: ['x'],
      workDir,
      cache: { dir: cacheDir },
      fingerprintFor, prefix: 'p', ext: 'mp3',
    })
    writeMiss(seed.entries[0]!, Buffer.from('SEEDED'))

    const plan = planBatch({
      texts: ['x', 'y', 'y'],
      workDir,
      cache: { dir: cacheDir },
      fingerprintFor, prefix: 'p', ext: 'mp3',
    })

    // entries[0] is a hit, entries[2] is a dup — both must reject writeMiss
    expect(() => writeMiss(plan.entries[0]!, Buffer.from('X'))).toThrow(/'hit'/)
    expect(() => writeMiss(plan.entries[2]!, Buffer.from('Y'))).toThrow(/'dup'/)
  })
})
