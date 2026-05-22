# Qwen3-TTS Voice Provider — Design

**Status:** Draft
**Date:** 2026-05-22
**Author:** Andreas Berger

## Summary

Add a local TTS provider backed by Alibaba's Qwen3-TTS family (`Qwen3-TTS-12Hz-0.6B-Base` for voice cloning, `Qwen3-TTS-12Hz-1.7B-VoiceDesign` for voice design). Two modes:

- **Clone mode** — user supplies a reference WAV/MP3 + the text spoken in it. The provider synthesizes target text in that voice.
- **Design mode** — user supplies a voice description (free-form prompt) + a reference text. The provider first generates a reference WAV from the description, then clones target text against it.

A Python sidecar runs the model (PyTorch + CUDA + `flash-attn` + `qwen-tts`); the TypeScript provider drives it over stdin/stdout JSON. Generated audio and the design reference WAV are cached on disk (opt-in flags) so repeated runs with the same inputs skip the model entirely.

This work also changes the `TtsProvider` contract to be batch-first and path-based across all providers (OpenAI / ElevenLabs / Polly / Qwen). This is a breaking change that ships in the same release.

## Motivation

`playwright-recast` currently supports three cloud TTS providers. Qwen3-TTS adds:

- **Voice control the cloud providers don't expose** — clone an arbitrary voice from a short reference sample, or design a voice from a textual description.
- **Offline operation** — no API key, no network, no per-character cost. Important for repeated iteration on a single demo video.
- **Determinism** — sampling is disabled by default; same inputs produce the same output, which makes the audio cache reliable.

The Qwen model load cost (~10-30s) only matters on the first cache miss; subsequent iterations on the same script are instant.

## Public API

### Provider factory

```ts
import { Recast, QwenTtsProvider } from 'playwright-recast'

// Clone mode
.voiceover(QwenTtsProvider({
  mode: 'clone',
  voiceSample: './my-voice.wav',
  refText: 'Welcome! In this screencast we will walk through the key concepts.',
  language: 'English',
  cacheAudio: true,
}))

// Design mode
.voiceover(QwenTtsProvider({
  mode: 'design',
  voiceDescription: 'A clear, steady male voice with a calm and even tone throughout.',
  refText: 'Welcome! In this screencast we will walk through the key concepts.',
  language: 'English',
  cacheAudio: true,
  cacheVoiceDesign: true,
}))
```

### Config types

```ts
interface QwenTtsCommonConfig {
  refText: string                                       // required in both modes
  language?: string                                     // Qwen-native name (default 'English')
  cloneModel?: string                                   // default 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'
  cacheDir?: string                                     // default './.recast-cache/voice'
  cacheAudio?: boolean                                  // default false
  pythonBin?: string                                    // default 'python3'
  device?: string                                       // default 'cuda:0'
  dtype?: 'bfloat16' | 'float16' | 'float32'            // default 'bfloat16'
}

interface QwenCloneModeConfig extends QwenTtsCommonConfig {
  mode: 'clone'
  voiceSample: string                                   // path to WAV/MP3
}

interface QwenDesignModeConfig extends QwenTtsCommonConfig {
  mode: 'design'
  voiceDescription: string
  designModel?: string                                  // default 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'
  cacheVoiceDesign?: boolean                            // default false
}

export type QwenTtsProviderConfig = QwenCloneModeConfig | QwenDesignModeConfig
```

The discriminated union enforces required fields at compile time. Construction-time validation re-checks: missing `refText`, both `voiceSample` and `voiceDescription` set, or neither set, all throw immediately.

`HF_TOKEN` is read from the environment by the sidecar (not part of config). Qwen sampling parameters (`do_sample=False`, `top_p=1.0`, `num_beams=1`) are hard-coded for determinism.

### Public exports

Added to `src/index.ts`:

```ts
export { QwenTtsProvider } from './voiceover/providers/qwen.js'
export type { QwenTtsProviderConfig } from './voiceover/providers/qwen.js'
```

## Breaking changes to the `TtsProvider` contract

The Qwen model batches efficiently on the GPU when given all texts in one call. The current `synthesize(text)` shape forces N round-trips. We switch the contract to be batch-first and path-based:

```ts
// src/types/voiceover.ts

export interface AudioSegment {
  path: string                                          // was: data: Buffer
  durationMs: number                                    // 0 if unknown; processor probes with ffprobe
  format: { sampleRate: number; channels: number; codec: string }
}

export interface TtsOptions {
  voice?: string
  model?: string
  languageCode?: string
  speed?: number
  format?: 'mp3' | 'wav' | 'opus' | 'pcm'
  workDir?: string                                      // NEW: where the provider should write outputs
}

export interface TtsProvider {
  readonly name: string
  synthesize(texts: string[], options?: TtsOptions): Promise<AudioSegment[]>  // batch + path-based
  estimateDurationMs(text: string, options?: TtsOptions): number
  isAvailable(): Promise<boolean>
  dispose(): Promise<void>
}
```

### Migration shape for cloud providers

Each cloud provider wraps its per-text call with `Promise.all`, writes the bytes to `opts.workDir`, and returns paths:

```ts
synthesize(texts: string[], opts) {
  const dir = opts?.workDir ?? os.tmpdir()
  return Promise.all(texts.map(async (text, i) => {
    const buf = await fetchSingleText(text)
    const p = path.join(dir, `${this.name}-${crypto.randomUUID()}.mp3`)
    await fs.promises.writeFile(p, buf)
    return { path: p, durationMs: 0, format: { sampleRate: ..., channels: 1, codec: 'mp3' } }
  }))
}
```

OpenAI, ElevenLabs, and Polly all get free concurrency from this change (they previously synthesized strictly sequentially).

### Processor refactor

`src/voiceover/voiceover-processor.ts` calls the provider once up front:

```ts
const texts = trace.subtitles.map(s => s.ttsText ?? s.text)
const audios = await provider.synthesize(texts, { workDir: tmpDir })

for (let si = 0; si < trace.subtitles.length; si++) {
  const subtitle = trace.subtitles[si]!
  const audio = audios[si]!
  // existing silence-padding, normalize, concat logic but reading from audio.path
  // instead of writeFileSync(rawPath, audio.data)
}
```

The `timeShift` mutation still works because we iterate subtitles in order with all durations already known after the batch returns. `normalizeLoudness(rawPath, segPath, ...)` already takes paths and is unaffected.

## Cache layout and hashing

### Directory structure

Under `cacheDir` (default `./.recast-cache/voice/`):

```
.recast-cache/voice/
├── design/
│   └── <designHash>.wav            # one per unique design input set
└── audio/
    └── <audioHash>.mp3             # one per unique target text + reference voice
```

The cache directory is created lazily — if both cache flags are off, nothing is written.

### Design hash (design mode only)

```
designHash = sha256(JSON.stringify({
  kind: 'design',
  voiceDescription,
  refText,
  language,
  designModel,
  dtype,
}))
```

### Audio hash (per target text)

```
audioHash = sha256(JSON.stringify({
  kind: 'audio',
  text,                            // the target text being synthesized
  language,
  cloneModel,
  dtype,
  refText,
  refAudioFingerprint,
}))
```

`refAudioFingerprint` is computed once per provider instance:

- **Clone mode** — `sha256(fileContents(voiceSample))`. Hash of the user's reference WAV/MP3 bytes.
- **Design mode** — `designHash` (above). Because the reference is itself derived deterministically from the design inputs, hashing those inputs is equivalent to hashing the (uncomputed) reference WAV bytes.

Consequence: in design mode, changing `voiceDescription` invalidates the design WAV AND every cached audio that referenced it. This is correct — the audio cache should not survive a voice change.

### Cache flag behaviour

- `cacheAudio: false` — audio is always regenerated. The provider writes the (converted) MP3 to a temp file under the processor's `workDir` instead of `cacheDir/audio/`. Cache reads are also skipped.
- `cacheVoiceDesign: false` — design WAV is always regenerated. Written to a temp file under `workDir`. Cache reads skipped. Cleaned up at end of `synthesize()`.
- Both flags default to `false`. Cache directory is not created unless at least one flag is on.

### Output format

- The sidecar produces WAV (Qwen native via `soundfile.write`).
- The provider converts each clone WAV to MP3 (single ffmpeg pass) before writing to the audio cache path or processor temp path. MP3 because the rest of `voiceover-processor.ts` is MP3-locked (`-c copy` concat, MP3 silence generator). Conversion is fast and happens only on cache miss.
- Design WAV is kept as-is in `cacheDir/design/` — it is an input to clone, not a pipeline segment.
- Making the cache format configurable is out of scope until the processor is made format-aware.

## Sidecar IPC

### Location and packaging

```
src/voiceover/providers/qwen-sidecar/
├── sidecar.py
├── requirements.txt          # torch, numpy, psutil, qwen-tts, soundfile, flash-attn
└── README.md                 # install + GPU requirements
```

The Python script ships inside the npm package. The provider invokes it as `${pythonBin} <abs-path-to>/sidecar.py`. Users must install the Python dependencies separately into whatever environment `pythonBin` resolves to.

### Protocol

JSON over stdin/stdout, one batch per spawn. Node writes the request as a single line, closes stdin, reads stdout until EOF, waits for exit.

**Request** (Node → Python stdin):

```json
{
  "workDir": "/abs/path/.recast-tmp/qwen-xxx",
  "device": "cuda:0",
  "dtype": "bfloat16",
  "language": "English",
  "cloneModel": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
  "design": {
    "designModel": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    "voiceDescription": "A clear, steady male voice...",
    "refText": "Welcome! In this screencast..."
  },
  "clone": {
    "refAudio": "/abs/path/to/ref.wav",
    "refText": "Welcome! In this screencast...",
    "texts": ["First we need to login", "Then enter the query"]
  }
}
```

- `design` is omitted when the design WAV is already cached or when in clone mode.
- `clone.refAudio` is the design output path when `design` is present, otherwise the cached design WAV, otherwise the user's `voiceSample`. Node chooses; the sidecar uses what it receives.
- `clone.texts` contains only cache misses. Node filters out hits before invoking the sidecar.
- If both `design` is absent and `clone.texts` is empty, **Node never spawns the sidecar.**

**Response on success** (Python stdout, single line JSON):

```json
{
  "ok": true,
  "design": { "path": "/abs/.recast-tmp/qwen-xxx/design.wav" },
  "clone":  [
    { "path": "/abs/.recast-tmp/qwen-xxx/clone-0.wav" },
    { "path": "/abs/.recast-tmp/qwen-xxx/clone-1.wav" }
  ]
}
```

- `design` key present only when the request had a `design` block.
- `clone` array aligns 1:1 with request `clone.texts` order.
- The sidecar owns the naming convention inside `workDir`; Node consumes the returned paths.

**Response on failure** (single line JSON, then exit 1):

```json
{
  "ok": false,
  "stage": "init" | "design" | "clone",
  "error": "human-readable message",
  "traceback": "python traceback string"
}
```

Node throws `QwenSidecarError` with the stage and message. Full traceback is also forwarded to stderr.

### Sidecar internals

```python
import json, sys, traceback

stage = "init"
results = {"ok": True}

try:
    # Anything that can fail before model work counts as 'init':
    #   - missing Python deps (ImportError on torch / qwen_tts / flash_attn / soundfile)
    #   - malformed request JSON from Node
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel
    req = json.loads(sys.stdin.read())

    if "design" in req:
        stage = "design"
        d = req["design"]
        m = Qwen3TTSModel.from_pretrained(
            d["designModel"],
            device_map=req["device"],
            dtype=getattr(torch, req["dtype"]),
            attn_implementation="flash_attention_2",
        )
        wavs, sr = m.generate_voice_design(
            text=[d["refText"]],
            language=req["language"],
            do_sample=False, top_p=1.0, num_beams=1,
            instruct=[d["voiceDescription"]],
        )
        design_path = f"{req['workDir']}/design.wav"
        sf.write(design_path, wavs[0], sr)
        results["design"] = {"path": design_path}
        del m
        torch.cuda.empty_cache()

    if req.get("clone", {}).get("texts"):
        stage = "clone"
        c = req["clone"]
        m = Qwen3TTSModel.from_pretrained(
            req["cloneModel"],
            device_map=req["device"],
            dtype=getattr(torch, req["dtype"]),
            attn_implementation="flash_attention_2",
        )
        wavs, sr = m.generate_voice_clone(
            text=c["texts"],
            language=req["language"],
            ref_audio=c["refAudio"],
            ref_text=c["refText"],
        )
        clone_results = []
        for i, wav in enumerate(wavs):
            p = f"{req['workDir']}/clone-{i}.wav"
            sf.write(p, wav, sr)
            clone_results.append({"path": p})
        results["clone"] = clone_results

    print(json.dumps(results))
except Exception as e:
    print(json.dumps({"ok": False, "stage": stage, "error": str(e), "traceback": traceback.format_exc()}))
    sys.exit(1)
```

The design model is released before the clone model loads to keep VRAM low.

### Node-side post-processing

For each call to `provider.synthesize(texts, { workDir })`:

1. Compute `audioHash` for every text. If `cacheAudio` is on, partition into `hits` and `misses` against `cacheDir/audio/`.
2. Resolve `refAudio`:
   - Clone mode → `config.voiceSample`.
   - Design mode → compute `designHash`. If `cacheVoiceDesign` is on and `cacheDir/design/<designHash>.wav` exists, use it. Otherwise schedule a `design` block in the request.
3. If `misses.length === 0` AND no design request → skip the sidecar entirely. Return cache-hit paths.
4. Otherwise create a sidecar-local `workDir` under the processor's `workDir` (e.g., `${processorTmp}/qwen-${uuid}`). Spawn the sidecar. Write request + newline to stdin. Read stdout. Wait for exit.
5. If `response.design` present:
   - `cacheVoiceDesign: true` → move WAV to `cacheDir/design/<designHash>.wav`.
   - `cacheVoiceDesign: false` → leave in sidecar `workDir`; it gets cleaned up at end of `synthesize()`.
6. For each clone result, ffmpeg-convert WAV → MP3 into either `cacheDir/audio/<audioHash>.mp3` (if `cacheAudio`) or `${processorWorkDir}/qwen-${uuid}.mp3` (if not).
7. Build the final `AudioSegment[]` array in input order: cache hits at their cached paths, fresh misses at the just-written MP3 paths.
8. Delete the sidecar-local `workDir` (cleanup).

### Failure modes Node handles explicitly

- `pythonBin` missing → `Error: Could not spawn '${pythonBin}'. Install Python 3 or set pythonBin in config.`
- ImportError on `qwen_tts` / `torch` / `flash_attn` → wrapped error with installation instructions pointing to `requirements.txt`.
- Non-zero exit with parseable JSON → `QwenSidecarError(stage, error)`.
- Non-zero exit without parseable JSON → raw stderr in the error message.
- Sidecar deadlock / hung process → no explicit timeout in v1; user kills the parent process. Optional `sidecarTimeoutMs` deferred until needed.

## Testing strategy

| Layer | What | How |
|---|---|---|
| Unit — hashing | `audioHash` / `designHash` deterministic, sensitive to each input | Vitest |
| Unit — config validation | Mode/refText invariants throw at construction | Vitest |
| Unit — request builder | Request shape correct for (miss-only, hit-only, mixed, design-needed, design-cached) | Vitest snapshot |
| Unit — response parser | Success and error responses parse correctly; `QwenSidecarError` carries the stage | Vitest |
| Integration — stub sidecar | `tests/fixtures/qwen-stub.py` reads the request and writes short silence WAVs to the response paths. Exercises full provider flow (cache write, cache hit on second call, WAV→MP3 conversion) without GPU or model downloads. | Vitest |
| Integration — processor batch refactor | Updated voiceover tests; new test that confirms `workDir` flows from processor → provider | Vitest |
| Manual — real model | `tests/manual/qwen-real.test.ts` gated by `RECAST_RUN_QWEN_TESTS=1`. Documented in CONTRIBUTING. Not in CI. | Manual |

The stub-sidecar pattern is what makes the entire Node side testable in CI.

## Out of scope (v1)

- **CLI integration.** No `--provider qwen` flags. Wider configuration surface than CLI flags express well.
- **MCP integration.** `RECAST_TTS_PROVIDER=qwen` is not auto-detected. Users can still hand the provider to `Recast` programmatically.
- **Streaming / progress callbacks.** No incremental progress API. Future addition via optional `onProgress` on `TtsOptions`.
- **WAV cache format.** MP3 only.
- **Cache eviction / size limits.** Cache grows unbounded; user manages it. Noted in README.
- **`languageCode` BCP-47 mapping.** `language: 'English'` only (Qwen native string). Mapping `'en' → 'English'` etc. deferred.
- **Sidecar timeout / heartbeat.** No explicit `sidecarTimeoutMs`. Deferred.

## Rollout

- **Version:** `0.15.x` → `0.16.0`. Breaking `TtsProvider` / `AudioSegment` change; minor bump under semver `0.x` convention.
- **CHANGELOG:** new provider section, the `synthesize(texts)` batch contract, the `AudioSegment.path` change, the per-provider migration snippet.
- **README:** new "Qwen3-TTS" subsection under "TTS Providers" — both modes, Python install instructions, GPU requirements, cache flag explanation.
- **Peer dependencies:** none added on the Node side. Python deps live in `sidecar/requirements.txt`, not enforced by npm.

## File list

```
src/voiceover/providers/qwen.ts                          (new — provider)
src/voiceover/providers/qwen-sidecar/sidecar.py          (new)
src/voiceover/providers/qwen-sidecar/requirements.txt    (new)
src/voiceover/providers/qwen-sidecar/README.md           (new)
src/voiceover/providers/openai.ts                        (refactor to batch + path)
src/voiceover/providers/elevenlabs.ts                    (refactor to batch + path)
src/voiceover/providers/polly.ts                         (refactor to batch + path)
src/voiceover/voiceover-processor.ts                     (refactor to batch call)
src/types/voiceover.ts                                   (AudioSegment + TtsProvider)
src/index.ts                                             (export QwenTtsProvider + type)
tests/fixtures/qwen-stub.py                              (new)
tests/voiceover/qwen.test.ts                             (new)
tests/voiceover/*                                        (update to batch interface)
README.md                                                (Qwen section)
CHANGELOG.md                                             (entry)
package.json                                             (version → 0.16.0)
```
