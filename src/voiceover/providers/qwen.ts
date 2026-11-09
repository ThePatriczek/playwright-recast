import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { runFfmpegAsync } from '../../utils/ffmpeg.js'
import { fileURLToPath } from 'node:url'
import type { TtsProvider, TtsOptions, AudioSegment } from '../../types/voiceover.js'
import { hashValues, hashFile } from './util/hash.js'

interface QwenTtsCommonConfig {
  refText: string
  language?: string
  cloneModel?: string
  cacheDir?: string
  cacheAudio?: boolean
  pythonBin?: string
  device?: string
  dtype?: 'bfloat16' | 'float16' | 'float32'
  /** Texts synthesized per model call (default 8). GPU memory grows with the
   *  batch, so a screencast with many new lines ran out of memory in one call. */
  batchSize?: number
  /** @internal — test-only override of the sidecar script path. */
  __pythonScriptPath__?: string
}

export interface QwenCloneModeConfig extends QwenTtsCommonConfig {
  mode: 'clone'
  voiceSample: string
}

export interface QwenDesignModeConfig extends QwenTtsCommonConfig {
  mode: 'design'
  voiceDescription: string
  designModel?: string
  cacheVoiceDesign?: boolean
}

export type QwenTtsProviderConfig = QwenCloneModeConfig | QwenDesignModeConfig

const DEFAULT_CLONE_MODEL = 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'
const DEFAULT_DESIGN_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'
const DEFAULT_CACHE_DIR = './.recast-cache/voice'
const DEFAULT_LANGUAGE = 'English'
const DEFAULT_PYTHON_BIN = 'python3'
const DEFAULT_DEVICE = 'cuda:0'
const DEFAULT_DTYPE = 'bfloat16' as const
const DEFAULT_BATCH_SIZE = 8

export class QwenSidecarError extends Error {
  readonly stage: 'init' | 'design' | 'clone'
  readonly pythonTraceback?: string
  /** What the sidecar finished before failing, e.g. the batches before one ran out of memory */
  readonly partial: { design?: { path: string }; clone?: CloneWav[] }
  constructor(
    stage: 'init' | 'design' | 'clone',
    message: string,
    traceback?: string,
    partial: { design?: { path: string }; clone?: CloneWav[] } = {},
  ) {
    super(`Qwen sidecar failed at stage '${stage}': ${message}`)
    this.name = 'QwenSidecarError'
    this.stage = stage
    this.pythonTraceback = traceback
    this.partial = partial
  }
}

/** A finished clone WAV; `index` is its text's position in the request. */
export interface CloneWav {
  index: number
  path: string
}

interface SidecarRequest {
  workDir: string
  device: string
  dtype: 'bfloat16' | 'float16' | 'float32'
  language: string
  cloneModel: string
  design?: {
    designModel: string
    voiceDescription: string
    refText: string
  }
  clone?: {
    refAudio: string
    refText: string
    texts: string[]
    batchSize: number
  }
}

interface SidecarResponseOk {
  ok: true
  design?: { path: string }
}

interface SidecarResponseErr {
  ok: false
  stage: 'init' | 'design' | 'clone'
  error: string
  traceback?: string
  design?: { path: string }
}

type SidecarResponse = SidecarResponseOk | SidecarResponseErr

interface SynthesisPlan {
  targets: Array<{ text: string; cachePath: string; hash: string }>
  /** Output path per input index. Cache hits + filled-in misses + duplicates. */
  paths: string[]
  /** Input indices that need to be synthesized by the sidecar. */
  missIndices: number[]
  /** Duplicates resolved by copying the canonical miss's output. */
  duplicates: Array<{ index: number; canonicalIndex: number }>
}

interface Sidecar {
  child: ChildProcess
  /** `stdout` holds the lines that are not WAV events: the response, or what crashed */
  exited: Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }>
  /** Each clone WAV, as soon as the sidecar wrote it */
  wavs: CloneWav[]
  onWav?: (wav: CloneWav) => void
}

const sidecarScript = (override: string | undefined): string =>
  override ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'qwen-sidecar', 'sidecar.py')

/** Starts the sidecar; it waits for its request on stdin. */
function startSidecar(pythonBin: string, script: string): Sidecar {
  const child = spawn(pythonBin, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let partialLine = ''
  let stderr = ''
  const wavs: CloneWav[] = []
  const takeLine = (line: string): void => {
    let event: { event?: unknown; index?: unknown; path?: unknown } | undefined
    try { event = JSON.parse(line) } catch { /* not an event */ }
    if (event?.event === 'wav' && typeof event.index === 'number' && typeof event.path === 'string') {
      const wav = { index: event.index, path: event.path }
      wavs.push(wav)
      sidecar.onWav?.(wav)
    } else {
      stdout += line + '\n'
    }
  }
  child.stdout!.setEncoding('utf8').on('data', (d: string) => {
    const lines = (partialLine + d).split('\n')
    partialLine = lines.pop()!
    lines.forEach(takeLine)
  })
  // Only the tail: model loading logs progress bars here
  child.stderr!.setEncoding('utf8').on('data', (d: string) => { stderr = (stderr + d).slice(-65536) })
  // A sidecar that already exited closes stdin; its response says why
  child.stdin!.on('error', () => {})
  const flush = (): void => {
    if (partialLine) takeLine(partialLine)
    partialLine = ''
  }
  const exited = new Promise<Awaited<Sidecar['exited']>>((resolve) => {
    child.on('error', (error) => { flush(); resolve({ status: null, stdout, stderr, error }) })
    child.on('close', (status) => { flush(); resolve({ status, stdout, stderr }) })
  })
  const sidecar: Sidecar = { child, exited, wavs }
  return sidecar
}

async function runSidecar(
  sidecar: Sidecar,
  pythonBin: string,
  req: SidecarRequest,
): Promise<SidecarResponseOk> {
  sidecar.child.stdin!.end(JSON.stringify(req))
  const r = await sidecar.exited
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(
      `QwenTtsProvider: could not spawn '${pythonBin}'. ` +
        `Install Python 3 or set pythonBin in config.`,
    )
  }
  const stdout = r.stdout.trim()
  let parsed: SidecarResponse | undefined
  if (stdout) {
    try {
      parsed = JSON.parse(stdout) as SidecarResponse
    } catch {
      // fall through — handled by exit code branch
    }
  }
  if (r.status === 0 && parsed && parsed.ok) {
    return parsed
  }
  if (parsed && !parsed.ok) {
    throw new QwenSidecarError(parsed.stage, parsed.error, parsed.traceback, { design: parsed.design, clone: sidecar.wavs })
  }
  throw new Error(
    `Qwen sidecar exited with status ${r.status}.\nstdout: ${stdout}\nstderr: ${r.stderr.trim()}`,
  )
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

async function convertWavToMp3(wavPath: string, mp3Path: string): Promise<void> {
  ensureDir(path.dirname(mp3Path))
  // Renamed when complete: a concurrent synthesize() takes an existing cache file as a hit
  const partial = `${mp3Path}.${crypto.randomUUID()}.partial`
  try {
    await runFfmpegAsync([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', wavPath,
      '-ac', '1',
      '-c:a', 'libmp3lame', '-b:a', '192k',
      '-f', 'mp3', partial,
    ])
    fs.renameSync(partial, mp3Path)
  } catch (err) {
    fs.rmSync(partial, { force: true })
    throw err
  }
}

export function QwenTtsProvider(config: QwenTtsProviderConfig): TtsProvider {
  if (!config.refText) {
    throw new Error('QwenTtsProvider: refText is required (in both clone and design modes)')
  }
  if (config.mode === 'clone') {
    if (!config.voiceSample) {
      throw new Error('QwenTtsProvider: voiceSample is required in clone mode')
    }
  } else if (config.mode === 'design') {
    if (!config.voiceDescription) {
      throw new Error('QwenTtsProvider: voiceDescription is required in design mode')
    }
  } else {
    throw new Error("QwenTtsProvider: mode must be 'clone' or 'design'")
  }

  const language = config.language ?? DEFAULT_LANGUAGE
  const cloneModel = config.cloneModel ?? DEFAULT_CLONE_MODEL
  const cacheDir = config.cacheDir ?? DEFAULT_CACHE_DIR
  const cacheAudio = config.cacheAudio ?? false
  const pythonBin = config.pythonBin ?? DEFAULT_PYTHON_BIN
  const device = config.device ?? DEFAULT_DEVICE
  const dtype = config.dtype ?? DEFAULT_DTYPE
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`QwenTtsProvider: batchSize must be a positive integer, got ${batchSize}`)
  }

  // Compute the reference-audio fingerprint once per provider instance.
  // In clone mode it's the hash of the user-provided file.
  // In design mode it equals designHashValue (the reference is derived from design inputs).
  let designModel: string | undefined
  let voiceDescription: string | undefined
  let cacheVoiceDesign = false
  let refAudioFingerprint: string
  let designHashValue: string | undefined

  if (config.mode === 'clone') {
    refAudioFingerprint = hashFile(config.voiceSample)
  } else {
    designModel = config.designModel ?? DEFAULT_DESIGN_MODEL
    voiceDescription = config.voiceDescription
    cacheVoiceDesign = config.cacheVoiceDesign ?? false
    designHashValue = hashValues([
      'design',
      voiceDescription,
      config.refText,
      language,
      designModel,
      dtype,
    ])
    refAudioFingerprint = designHashValue
  }

  function audioCachePathFor(text: string): { hash: string; cachePath: string } {
    const hash = hashValues([
      'audio',
      text,
      language,
      cloneModel,
      dtype,
      config.refText,
      refAudioFingerprint,
    ])
    return { hash, cachePath: path.join(cacheDir, 'audio', `${hash}.mp3`) }
  }

  function designCachePath(): string {
    return path.join(cacheDir, 'design', `${designHashValue}.wav`)
  }

  /** Partition `texts` into cache hits (resolved immediately), misses (to send to
   *  the sidecar), and duplicates (filled later by copying a canonical miss). */
  function planSynthesis(texts: string[], tmpDir: string): SynthesisPlan {
    const targets = texts.map((text) => {
      const { hash, cachePath } = audioCachePathFor(text)
      return { text, cachePath, hash }
    })
    const paths: string[] = Array.from({ length: targets.length }, () => '')
    const missIndices: number[] = []
    const duplicates: Array<{ index: number; canonicalIndex: number }> = []
    const canonicalByHash = new Map<string, number>()
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!
      if (cacheAudio && fs.existsSync(t.cachePath)) {
        const ephemeral = path.join(tmpDir, `qwen-cachehit-${t.hash}.mp3`)
        fs.copyFileSync(t.cachePath, ephemeral)
        paths[i] = ephemeral
        continue
      }
      const canonicalIndex = canonicalByHash.get(t.hash)
      if (canonicalIndex !== undefined) {
        duplicates.push({ index: i, canonicalIndex })
      } else {
        missIndices.push(i)
        canonicalByHash.set(t.hash, i)
      }
    }
    return { targets, paths, missIndices, duplicates }
  }

  /** Pick the reference audio path and decide whether the sidecar must generate
   *  a fresh design WAV first. */
  function resolveRefAudio(sidecarDir: string): { refAudio: string; scheduledDesign: boolean } {
    if (config.mode === 'clone') {
      return { refAudio: config.voiceSample, scheduledDesign: false }
    }
    const cached = designCachePath()
    if (cacheVoiceDesign && fs.existsSync(cached)) {
      return { refAudio: cached, scheduledDesign: false }
    }
    return { refAudio: path.join(sidecarDir, 'design.wav'), scheduledDesign: true }
  }

  function buildSidecarRequest(
    plan: SynthesisPlan,
    sidecarDir: string,
    refAudio: string,
    scheduledDesign: boolean,
  ): SidecarRequest {
    const req: SidecarRequest = {
      workDir: sidecarDir,
      device, dtype, language, cloneModel,
    }
    if (scheduledDesign) {
      req.design = {
        designModel: designModel!,
        voiceDescription: voiceDescription!,
        refText: config.refText,
      }
    }
    if (plan.missIndices.length > 0) {
      req.clone = {
        refAudio,
        refText: config.refText,
        texts: plan.missIndices.map((i) => plan.targets[i]!.text),
        batchSize,
      }
    }
    return req
  }

  /** Move the freshly produced design WAV into the cache if caching is enabled.
   *  Otherwise leaves it under sidecarDir, where the caller cleans it up. */
  function persistDesignWav(producedPath: string): void {
    if (!cacheVoiceDesign || !designHashValue) return
    const target = designCachePath()
    ensureDir(path.dirname(target))
    try {
      fs.renameSync(producedPath, target)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      fs.copyFileSync(producedPath, target)
      fs.unlinkSync(producedPath)
    }
  }

  /** Convert a clone WAV to MP3 and record its ephemeral path in the plan.
   *  When caching, writes to the cache first and hands the processor a copy so
   *  a renameSync in the caller cannot destroy the cached file. */
  async function persistCloneWav(wav: CloneWav, plan: SynthesisPlan, tmpDir: string): Promise<void> {
    const targetIdx = plan.missIndices[wav.index]
    if (targetIdx === undefined) throw new Error(`Qwen sidecar returned a WAV for unknown text #${wav.index}`)
    const t = plan.targets[targetIdx]!
    const ephemeral = path.join(tmpDir, `qwen-${t.hash}.mp3`)
    if (cacheAudio) {
      await convertWavToMp3(wav.path, t.cachePath)
      fs.copyFileSync(t.cachePath, ephemeral)
    } else {
      await convertWavToMp3(wav.path, ephemeral)
    }
    plan.paths[targetIdx] = ephemeral
  }

  /** Each duplicate gets its own ephemeral copy so the processor can rename or
   *  move each path independently without hitting ENOENT on reuse. */
  function fillDuplicates(plan: SynthesisPlan, tmpDir: string): void {
    for (const { index, canonicalIndex } of plan.duplicates) {
      const { hash } = plan.targets[index]!
      const dupPath = path.join(tmpDir, `qwen-dup-${index}-${hash}.mp3`)
      fs.copyFileSync(plan.paths[canonicalIndex]!, dupPath)
      plan.paths[index] = dupPath
    }
  }

  function buildResult(plan: SynthesisPlan): AudioSegment[] {
    return plan.paths.map((p) => ({
      path: p,
      durationMs: 0,
      format: { sampleRate: 24000, channels: 1, codec: 'mp3' },
    }))
  }

  return {
    name: 'qwen',

    async synthesize(texts: string[], options?: TtsOptions): Promise<AudioSegment[]> {
      const tmpDir = options?.workDir ?? os.tmpdir()
      ensureDir(tmpDir)
      // Sidecar runs need their own workspace so cleanup is unambiguous.
      const sidecarDir = path.join(tmpDir, `qwen-${crypto.randomUUID()}`)
      ensureDir(sidecarDir)
      try {
        const plan = planSynthesis(texts, tmpDir)
        const { refAudio, scheduledDesign } = resolveRefAudio(sidecarDir)
        if (scheduledDesign || plan.missIndices.length > 0) {
          const sidecar = startSidecar(pythonBin, sidecarScript(config.__pythonScriptPath__))
          // Each WAV converts while the sidecar makes the next ones; one at a
          // time, so a fast model cannot start an ffmpeg per line at once
          const conversions: Array<Promise<void>> = []
          let previous: Promise<unknown> = Promise.resolve()
          sidecar.onWav = (wav) => {
            const conversion = previous.then(() => persistCloneWav(wav, plan, tmpDir))
            // Awaited below: a failure until then must not count as unhandled
            previous = conversion.catch(() => {})
            conversions.push(conversion)
          }
          let resp: SidecarResponseOk
          try {
            resp = await runSidecar(
              sidecar,
              pythonBin,
              buildSidecarRequest(plan, sidecarDir, refAudio, scheduledDesign),
            )
          } catch (err) {
            // The finished WAVs are in the cache by now, so a rerun only makes
            // the rest; the per-run copies go. Best effort: a failure here must
            // not hide the sidecar's error.
            await Promise.allSettled(conversions)
            for (const p of plan.paths) if (p) fs.rmSync(p, { force: true })
            if (err instanceof QwenSidecarError && err.partial.design) {
              try { persistDesignWav(err.partial.design.path) } catch { /* keep the sidecar's error */ }
            }
            throw err
          }
          // All settled before the finally removes the WAVs they read
          const failed = (await Promise.allSettled(conversions)).find((r) => r.status === 'rejected')
          if (failed) {
            for (const p of plan.paths) if (p) fs.rmSync(p, { force: true })
            throw failed.reason
          }
          if (resp.design) persistDesignWav(resp.design.path)
        }
        fillDuplicates(plan, tmpDir)
        return buildResult(plan)
      } finally {
        fs.rmSync(sidecarDir, { recursive: true, force: true })
      }
    },

    async isAvailable(): Promise<boolean> {
      const r = spawnSync(pythonBin, ['--version'], { stdio: 'ignore' })
      if (r.status !== 0) return false
      return fs.existsSync(sidecarScript(config.__pythonScriptPath__))
    },

    async dispose(): Promise<void> {
      // sidecar is per-call; nothing to release
    },
  }
}
