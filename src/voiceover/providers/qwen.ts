import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
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

export class QwenSidecarError extends Error {
  readonly stage: 'init' | 'design' | 'clone'
  readonly pythonTraceback?: string
  constructor(stage: 'init' | 'design' | 'clone', message: string, traceback?: string) {
    super(`Qwen sidecar failed at stage '${stage}': ${message}`)
    this.name = 'QwenSidecarError'
    this.stage = stage
    this.pythonTraceback = traceback
  }
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
  }
}

interface SidecarResponseOk {
  ok: true
  design?: { path: string }
  clone?: Array<{ path: string }>
}

interface SidecarResponseErr {
  ok: false
  stage: 'init' | 'design' | 'clone'
  error: string
  traceback?: string
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

function runSidecar(
  pythonBin: string,
  scriptOverride: string | undefined,
  req: SidecarRequest,
): SidecarResponseOk {
  const scriptPath = scriptOverride
    ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'qwen-sidecar', 'sidecar.py')
  const r = spawnSync(pythonBin, [scriptPath], {
    input: JSON.stringify(req),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(
      `QwenTtsProvider: could not spawn '${pythonBin}'. ` +
        `Install Python 3 or set pythonBin in config.`,
    )
  }
  const stdout = (r.stdout ?? '').trim()
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
    throw new QwenSidecarError(parsed.stage, parsed.error, parsed.traceback)
  }
  const stderr = (r.stderr ?? '').trim()
  throw new Error(
    `Qwen sidecar exited with status ${r.status}.\nstdout: ${stdout}\nstderr: ${stderr}`,
  )
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function convertWavToMp3(wavPath: string, mp3Path: string): void {
  ensureDir(path.dirname(mp3Path))
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', wavPath,
    '-ac', '1',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    mp3Path,
  ], { stdio: 'pipe' })
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

  /** Convert each clone WAV to MP3 and record its ephemeral path in the plan.
   *  When caching, writes to the cache first and hands the processor a copy so
   *  a renameSync in the caller cannot destroy the cached file. */
  function persistCloneWavs(
    cloneWavs: ReadonlyArray<{ path: string }>,
    plan: SynthesisPlan,
    tmpDir: string,
  ): void {
    for (let k = 0; k < cloneWavs.length; k++) {
      const targetIdx = plan.missIndices[k]!
      const t = plan.targets[targetIdx]!
      const ephemeral = path.join(tmpDir, `qwen-${t.hash}.mp3`)
      if (cacheAudio) {
        convertWavToMp3(cloneWavs[k]!.path, t.cachePath)
        fs.copyFileSync(t.cachePath, ephemeral)
      } else {
        convertWavToMp3(cloneWavs[k]!.path, ephemeral)
      }
      plan.paths[targetIdx] = ephemeral
    }
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
          const resp = runSidecar(
            pythonBin,
            config.__pythonScriptPath__,
            buildSidecarRequest(plan, sidecarDir, refAudio, scheduledDesign),
          )
          if (resp.design) persistDesignWav(resp.design.path)
          persistCloneWavs(resp.clone ?? [], plan, tmpDir)
        }
        fillDuplicates(plan, tmpDir)
        return buildResult(plan)
      } finally {
        fs.rmSync(sidecarDir, { recursive: true, force: true })
      }
    },

    estimateDurationMs(text: string): number {
      const words = text.split(/\s+/).length
      return (words / 150) * 60_000
    },

    async isAvailable(): Promise<boolean> {
      return true
    },

    async dispose(): Promise<void> {
      // sidecar is per-call; nothing to release
    },
  }
}
