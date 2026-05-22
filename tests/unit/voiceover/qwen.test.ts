import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { QwenTtsProvider } from '../../../src/voiceover/providers/qwen'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const TMP = path.join(os.tmpdir(), `qwen-provider-test-${process.pid}`)
const STUB_SCRIPT = path.resolve(__dirname, '../../fixtures/qwen-stub.py')

beforeAll(() => fs.mkdirSync(TMP, { recursive: true }))
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

function makeVoiceSample(dir: string, name = 'voice.wav', bytes = Buffer.from('VOICE')): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, bytes)
  return p
}

describe('QwenTtsProvider config validation', () => {
  it('clone mode requires voiceSample', () => {
    expect(() => QwenTtsProvider({
      mode: 'clone',
      // @ts-expect-error voiceSample missing on purpose
      refText: 'hi',
    })).toThrow(/voiceSample/)
  })

  it('clone mode requires refText', () => {
    expect(() => QwenTtsProvider({
      mode: 'clone',
      // @ts-expect-error refText missing on purpose
      voiceSample: '/tmp/x.wav',
    })).toThrow(/refText/)
  })

  it('design mode requires voiceDescription', () => {
    expect(() => QwenTtsProvider({
      mode: 'design',
      // @ts-expect-error voiceDescription missing on purpose
      refText: 'hi',
    })).toThrow(/voiceDescription/)
  })

  it('design mode requires refText', () => {
    expect(() => QwenTtsProvider({
      mode: 'design',
      // @ts-expect-error refText missing on purpose
      voiceDescription: 'a calm voice',
    })).toThrow(/refText/)
  })

  it('clone-mode provider exposes name "qwen"', () => {
    const samplePath = path.join(TMP, 'name-test-voice.wav')
    fs.writeFileSync(samplePath, Buffer.from('VOICE'))
    const p = QwenTtsProvider({
      mode: 'clone',
      voiceSample: samplePath,
      refText: 'hi',
    })
    expect(p.name).toBe('qwen')
  })

  it('design-mode provider exposes name "qwen"', () => {
    const p = QwenTtsProvider({
      mode: 'design',
      voiceDescription: 'a calm voice',
      refText: 'hi',
    })
    expect(p.name).toBe('qwen')
  })

  it('isAvailable returns true (no api key needed)', async () => {
    const samplePath = path.join(TMP, 'avail-test-voice.wav')
    fs.writeFileSync(samplePath, Buffer.from('VOICE'))
    const p = QwenTtsProvider({
      mode: 'clone',
      voiceSample: samplePath,
      refText: 'hi',
    })
    expect(await p.isAvailable()).toBe(true)
  })
})

describe('QwenTtsProvider synthesize() — clone mode through stub sidecar', () => {
  it('writes one MP3 per input text and returns paths in order', async () => {
    const workDir = path.join(TMP, 'work-clone-basic')
    fs.mkdirSync(workDir, { recursive: true })
    const voiceSample = makeVoiceSample(workDir)

    const p = QwenTtsProvider({
      mode: 'clone',
      voiceSample,
      refText: 'Welcome',
      __pythonScriptPath__: STUB_SCRIPT,
    })
    const out = await p.synthesize(['first', 'second'], { workDir })

    expect(out).toHaveLength(2)
    expect(out[0]!.path.endsWith('.mp3')).toBe(true)
    expect(fs.existsSync(out[0]!.path)).toBe(true)
    expect(fs.existsSync(out[1]!.path)).toBe(true)
    expect(out[0]!.format.codec).toBe('mp3')
  })
})

describe('QwenTtsProvider synthesize() — audio cache', () => {
  it('with cacheAudio:true, second call skips the sidecar', async () => {
    const workDir = path.join(TMP, 'work-cache-hit')
    fs.mkdirSync(workDir, { recursive: true })
    const cacheDir = path.join(TMP, 'cache-hit')
    const voiceSample = makeVoiceSample(workDir)

    const p = QwenTtsProvider({
      mode: 'clone',
      voiceSample,
      refText: 'Welcome',
      cacheDir,
      cacheAudio: true,
      __pythonScriptPath__: STUB_SCRIPT,
    })

    const first = await p.synthesize(['hello'], { workDir })
    // With the ephemeral-copy contract, returned path is under workDir (not cacheDir/audio).
    expect(first[0]!.path.startsWith(workDir)).toBe(true)
    expect(fs.existsSync(first[0]!.path)).toBe(true)

    // Make the stub fail if it's invoked the second time — proves cache hit.
    const failingStub = path.join(TMP, 'failing-stub.py')
    fs.writeFileSync(failingStub, 'import sys\nsys.exit(99)\n')
    const p2 = QwenTtsProvider({
      mode: 'clone',
      voiceSample,
      refText: 'Welcome',
      cacheDir,
      cacheAudio: true,
      __pythonScriptPath__: failingStub,
    })
    const second = await p2.synthesize(['hello'], { workDir })
    // Both calls returned ephemeral paths under workDir; the cache is what matters.
    expect(second[0]!.path.startsWith(workDir)).toBe(true)
  })

  it('with cacheAudio:false, output goes under workDir not cacheDir', async () => {
    const workDir = path.join(TMP, 'work-no-cache')
    fs.mkdirSync(workDir, { recursive: true })
    const cacheDir = path.join(TMP, 'cache-no-cache')
    const voiceSample = makeVoiceSample(workDir)

    const p = QwenTtsProvider({
      mode: 'clone',
      voiceSample,
      refText: 'Welcome',
      cacheDir,
      cacheAudio: false,
      __pythonScriptPath__: STUB_SCRIPT,
    })

    const out = await p.synthesize(['hello'], { workDir })
    expect(out[0]!.path.startsWith(workDir)).toBe(true)
    expect(fs.existsSync(path.join(cacheDir, 'audio'))).toBe(false)
  })

  it('with duplicate texts, only one is sent to the sidecar; both indices share the same MP3', async () => {
    const workDir = path.join(TMP, 'work-dup')
    fs.mkdirSync(workDir, { recursive: true })
    const cacheDir = path.join(TMP, 'cache-dup')
    const voiceSample = makeVoiceSample(workDir)

    // Counting stub: records the number of clone.texts it saw to a file
    const countFile = path.join(TMP, 'dup-count.txt')
    const countingStub = path.join(TMP, 'counting-stub.py')
    fs.writeFileSync(countingStub, [
      'import json, sys, struct, wave',
      'req = json.loads(sys.stdin.read())',
      'with open(' + JSON.stringify(countFile) + ', "w") as f: f.write(str(len(req["clone"]["texts"])))',
      'work = req["workDir"]',
      'results = {"ok": True, "clone": []}',
      'for i, _ in enumerate(req["clone"]["texts"]):',
      '    p = f"{work}/clone-{i}.wav"',
      '    with wave.open(p, "wb") as w:',
      '        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)',
      '        w.writeframes(struct.pack("<" + "h" * 1000, *([0] * 1000)))',
      '    results["clone"].append({"path": p})',
      'print(json.dumps(results))',
    ].join('\n'))

    const p = QwenTtsProvider({
      mode: 'clone',
      voiceSample,
      refText: 'Welcome',
      cacheDir,
      cacheAudio: true,
      __pythonScriptPath__: countingStub,
    })

    const out = await p.synthesize(['hello', 'hello', 'world'], { workDir })
    expect(out).toHaveLength(3)
    // Duplicates get separate ephemeral copies (so each can be independently renamed by the processor).
    expect(out[0]!.path).not.toBe(out[1]!.path)
    // But the files are byte-identical (same underlying audio).
    expect(fs.readFileSync(out[0]!.path)).toEqual(fs.readFileSync(out[1]!.path))
    expect(out[2]!.path).not.toBe(out[0]!.path)
    expect(fs.readFileSync(countFile, 'utf8')).toBe('2')  // only 'hello' + 'world' sent to sidecar
  })

  it('after generateVoiceover-style consumption of audio.path, the cache file still exists', async () => {
    const workDir = path.join(TMP, 'work-cache-survives')
    fs.mkdirSync(workDir, { recursive: true })
    const cacheDir = path.join(TMP, 'cache-survives')
    const voiceSample = makeVoiceSample(workDir)

    const p = QwenTtsProvider({
      mode: 'clone',
      voiceSample,
      refText: 'Welcome',
      cacheDir,
      cacheAudio: true,
      __pythonScriptPath__: STUB_SCRIPT,
    })

    const out = await p.synthesize(['hello'], { workDir })
    expect(out[0]!.path.startsWith(workDir)).toBe(true)  // returned path is ephemeral, in workDir

    // Simulate what generateVoiceover does: move the returned file.
    const consumed = path.join(workDir, 'consumed.mp3')
    fs.renameSync(out[0]!.path, consumed)

    // The cache file must still exist for a future run to hit it.
    const cacheFiles = fs.readdirSync(path.join(cacheDir, 'audio'))
    expect(cacheFiles).toHaveLength(1)
    expect(cacheFiles[0]!.endsWith('.mp3')).toBe(true)
  })
})

describe('QwenTtsProvider synthesize() — design mode', () => {
  it('without design cache, runs design + clone in one sidecar call', async () => {
    const workDir = path.join(TMP, 'work-design-fresh')
    fs.mkdirSync(workDir, { recursive: true })
    const cacheDir = path.join(TMP, 'cache-design-fresh')

    const p = QwenTtsProvider({
      mode: 'design',
      voiceDescription: 'A calm male voice',
      refText: 'Welcome',
      cacheDir,
      cacheAudio: true,
      cacheVoiceDesign: true,
      __pythonScriptPath__: STUB_SCRIPT,
    })

    const out = await p.synthesize(['hello'], { workDir })

    expect(out).toHaveLength(1)
    expect(fs.existsSync(out[0]!.path)).toBe(true)
    // Design WAV should have been moved into the cache.
    const designDir = path.join(cacheDir, 'design')
    expect(fs.existsSync(designDir)).toBe(true)
    expect(fs.readdirSync(designDir).filter((f) => f.endsWith('.wav'))).toHaveLength(1)
  })

  it('with design cache present, subsequent call uses cached design WAV (no design block sent)', async () => {
    const workDir = path.join(TMP, 'work-design-reuse')
    fs.mkdirSync(workDir, { recursive: true })
    const cacheDir = path.join(TMP, 'cache-design-reuse')

    const p1 = QwenTtsProvider({
      mode: 'design',
      voiceDescription: 'A calm male voice',
      refText: 'Welcome',
      cacheDir,
      cacheAudio: false, // force clone work both times
      cacheVoiceDesign: true,
      __pythonScriptPath__: STUB_SCRIPT,
    })
    await p1.synthesize(['hello'], { workDir })

    // A stub that fails if 'design' is in the request — proves no design was sent.
    const designSentinelStub = path.join(TMP, 'design-sentinel.py')
    fs.writeFileSync(designSentinelStub, [
      'import json, sys, struct, wave',
      'req = json.loads(sys.stdin.read())',
      'assert "design" not in req, "design block leaked through cache"',
      'work = req["workDir"]',
      'results = {"ok": True, "clone": []}',
      'for i, _ in enumerate(req["clone"]["texts"]):',
      '    p = f"{work}/clone-{i}.wav"',
      '    with wave.open(p, "wb") as w:',
      '        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)',
      '        w.writeframes(struct.pack("<" + "h" * 1000, *([0] * 1000)))',
      '    results["clone"].append({"path": p})',
      'print(json.dumps(results))',
    ].join('\n'))

    const p2 = QwenTtsProvider({
      mode: 'design',
      voiceDescription: 'A calm male voice',
      refText: 'Welcome',
      cacheDir,
      cacheAudio: false,
      cacheVoiceDesign: true,
      __pythonScriptPath__: designSentinelStub,
    })
    await expect(p2.synthesize(['hello'], { workDir })).resolves.toBeDefined()
  })
})

describe('QwenTtsProvider synthesize() — sidecar errors', () => {
  it('sidecar reporting ok=false at stage=clone throws QwenSidecarError with stage', async () => {
    const workDir = path.join(TMP, 'work-err-clone')
    fs.mkdirSync(workDir, { recursive: true })
    const voiceSample = makeVoiceSample(workDir)

    // Use a tiny inline script that emits an ok:false JSON.
    const failingStub = path.join(TMP, 'err-stub-clone.py')
    fs.writeFileSync(failingStub, [
      'import json, sys',
      'print(json.dumps({"ok": False, "stage": "clone", "error": "boom", "traceback": "..."}))',
      'sys.exit(1)',
    ].join('\n'))

    const p = QwenTtsProvider({
      mode: 'clone',
      voiceSample,
      refText: 'Welcome',
      __pythonScriptPath__: failingStub,
    })

    const err = await p.synthesize(['hello'], { workDir }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('QwenSidecarError')
    expect(err.stage).toBe('clone')
    expect(err.message).toContain('boom')
  })

  it('missing pythonBin yields a clear error message', async () => {
    const workDir = path.join(TMP, 'work-no-python')
    fs.mkdirSync(workDir, { recursive: true })
    const voiceSample = makeVoiceSample(workDir)

    const p = QwenTtsProvider({
      mode: 'clone',
      voiceSample,
      refText: 'Welcome',
      pythonBin: '/non/existent/python-binary-xyz',
      __pythonScriptPath__: STUB_SCRIPT,
    })

    await expect(p.synthesize(['hello'], { workDir })).rejects.toThrow(
      /could not spawn .*python-binary-xyz/i,
    )
  })
})
