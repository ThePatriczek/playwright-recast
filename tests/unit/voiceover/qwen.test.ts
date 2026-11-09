import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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
      'results = {"ok": True}',
      'for i, _ in enumerate(req["clone"]["texts"]):',
      '    p = f"{work}/clone-{i}.wav"',
      '    with wave.open(p, "wb") as w:',
      '        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)',
      '        w.writeframes(struct.pack("<" + "h" * 1000, *([0] * 1000)))',
      '    print(json.dumps({"event": "wav", "index": i, "path": p}), flush=True)',
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

  it('fails with a conversion error after every conversion settled', async () => {
    const workDir = path.join(TMP, 'work-convert-fail')
    fs.mkdirSync(workDir, { recursive: true })
    const voiceSample = makeVoiceSample(workDir)
    // The first WAV is not audio; the second is long enough to still be
    // converting when the first fails
    const stub = path.join(TMP, 'convert-fail-stub.py')
    fs.writeFileSync(stub, [
      'import json, sys, struct, wave',
      'req = json.loads(sys.stdin.read())',
      'work = req["workDir"]',
      'for i, _ in enumerate(req["clone"]["texts"]):',
      '    p = f"{work}/clone-{i}.wav"',
      '    if i == 0:',
      '        open(p, "w").write("not a wav")',
      '    else:',
      '        with wave.open(p, "wb") as w:',
      '            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)',
      '            w.writeframes(bytes(2 * 24000 * 120))',
      '    print(json.dumps({"event": "wav", "index": i, "path": p}), flush=True)',
      'print(json.dumps({"ok": True}))',
    ].join('\n'))
    const cacheDir = path.join(TMP, 'cache-convert-fail')
    const qwen = QwenTtsProvider({ mode: 'clone', voiceSample, refText: 'Welcome', cacheDir, cacheAudio: true, __pythonScriptPath__: stub })
    await expect(qwen.synthesize(['bad', 'good'], { workDir })).rejects.toThrow(/ffmpeg/i)
    // The good line still made it into the cache
    expect(fs.readdirSync(path.join(cacheDir, 'audio'))).toHaveLength(1)
  })

  it('names a cache file only once its conversion is complete', async () => {
    const workDir = path.join(TMP, 'work-cache-atomic')
    fs.mkdirSync(workDir, { recursive: true })
    const voiceSample = makeVoiceSample(workDir)
    // Long enough to watch the conversion run
    const stub = path.join(TMP, 'cache-atomic-stub.py')
    fs.writeFileSync(stub, [
      'import json, sys, wave',
      'req = json.loads(sys.stdin.read())',
      'p = f"{req[\'workDir\']}/clone-0.wav"',
      'with wave.open(p, "wb") as w:',
      '    w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)',
      '    w.writeframes(bytes(2 * 24000 * 600))',
      'print(json.dumps({"event": "wav", "index": 0, "path": p}), flush=True)',
      'print(json.dumps({"ok": True}))',
    ].join('\n'))
    const audioDir = path.join(TMP, 'cache-atomic', 'audio')
    const qwen = QwenTtsProvider({ mode: 'clone', voiceSample, refText: 'Welcome', cacheDir: path.join(TMP, 'cache-atomic'), cacheAudio: true, __pythonScriptPath__: stub })
    const done = qwen.synthesize(['long'], { workDir })
    const list = () => (fs.existsSync(audioDir) ? fs.readdirSync(audioDir) : [])
    for (let i = 0; i < 400 && !list().some((f) => f.endsWith('.partial')); i++) await new Promise((r) => setTimeout(r, 5))
    const during = list()
    await done
    expect(during.some((f) => f.endsWith('.partial'))).toBe(true)
    expect(during.filter((f) => f.endsWith('.mp3'))).toEqual([])
    expect(list().filter((f) => !f.endsWith('.mp3'))).toEqual([])
  })

  it('sends the batch size to the sidecar, 8 unless configured', async () => {
    const workDir = path.join(TMP, 'work-batch')
    fs.mkdirSync(workDir, { recursive: true })
    const voiceSample = makeVoiceSample(workDir)
    const seenFile = path.join(TMP, 'batch-seen.txt')
    const stub = path.join(TMP, 'batch-stub.py')
    fs.writeFileSync(stub, [
      'import json, sys, struct, wave',
      'req = json.loads(sys.stdin.read())',
      'with open(' + JSON.stringify(seenFile) + ', "w") as f: f.write(str(req["clone"]["batchSize"]))',
      'work = req["workDir"]',
      'results = {"ok": True}',
      'for i, _ in enumerate(req["clone"]["texts"]):',
      '    p = f"{work}/clone-{i}.wav"',
      '    with wave.open(p, "wb") as w:',
      '        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)',
      '        w.writeframes(struct.pack("<" + "h" * 1000, *([0] * 1000)))',
      '    print(json.dumps({"event": "wav", "index": i, "path": p}), flush=True)',
      'print(json.dumps(results))',
    ].join('\n'))
    const make = (batchSize?: number) => QwenTtsProvider({
      mode: 'clone', voiceSample, refText: 'Welcome', __pythonScriptPath__: stub,
      ...(batchSize ? { batchSize } : {}),
    })

    await make().synthesize(['one'], { workDir })
    expect(fs.readFileSync(seenFile, 'utf8')).toBe('8')
    await make(3).synthesize(['two'], { workDir })
    expect(fs.readFileSync(seenFile, 'utf8')).toBe('3')
  })

  describe('the real sidecar, on stub qwen_tts, torch and soundfile modules', () => {
    const MODULES = path.resolve(__dirname, '../../fixtures/qwen-modules')
    const texts = ['t0', 't1', 't2', 't3', 't4', 't5', 't6']
    const log = (name: string) => path.join(TMP, `${name}.log`)
    const read = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const provider = (name: string, cacheDir: string, failBatch?: number, runaway = '') => {
      fs.rmSync(log(name), { force: true })
      vi.stubEnv('PYTHONPATH', MODULES)
      vi.stubEnv('PYTHONDONTWRITEBYTECODE', '1')
      vi.stubEnv('QWEN_STUB_LOG', log(name))
      vi.stubEnv('QWEN_STUB_FAIL_BATCH', failBatch === undefined ? '' : String(failBatch))
      vi.stubEnv('QWEN_STUB_RUNAWAY', runaway)
      const workDir = path.join(TMP, `work-${name}`)
      fs.mkdirSync(workDir, { recursive: true })
      const voiceSample = makeVoiceSample(workDir)
      return { workDir, qwen: QwenTtsProvider({ mode: 'clone', voiceSample, refText: 'Welcome', batchSize: 3, cacheDir, cacheAudio: true }) }
    }
    const run = (name: string, cacheDir: string, failBatch?: number, runaway?: string, inputs = texts) => {
      const { workDir, qwen } = provider(name, cacheDir, failBatch, runaway)
      return qwen.synthesize(inputs, { workDir })
    }
    afterAll(() => { vi.unstubAllEnvs() })

    it('synthesizes in batches, writing each text to its own file and preparing the voice once', async () => {
      const out = await run('batches', path.join(TMP, 'cache-batches'))
      expect(out).toHaveLength(7)
      const entries = read(log('batches'))
      expect(entries.filter((e) => e.prompt)).toHaveLength(1)
      expect(entries.filter((e) => e.batch).map((e) => e.batch)).toEqual([['t0', 't1', 't2'], ['t3', 't4', 't5'], ['t6']])
      expect(entries.filter((e) => e.write).map((e) => e.write)).toEqual(texts.map((t, i) => [`clone-${i}.wav`, t]))
    })

    it('synthesizes the shortest texts first, under a frame cap that grows with the text', async () => {
      const inputs = ['a much longer line', 'mid line', 'x']
      const out = await run('shortest-first', path.join(TMP, 'cache-shortest-first'), undefined, undefined, inputs)
      expect(out).toHaveLength(3)
      const batches = read(log('shortest-first')).filter((e) => e.batch)
      expect(batches.map((e) => e.batch)).toEqual([['x', 'mid line', 'a much longer line']])
      // Written under each text's own position
      expect(read(log('shortest-first')).filter((e) => e.write).map((e) => e.write)).toEqual([
        ['clone-2.wav', 'x'], ['clone-1.wav', 'mid line'], ['clone-0.wav', 'a much longer line'],
      ])
      // 12.5 frames/s for 2 s plus 1 s per 6 characters, set by the batch's longest text
      expect(batches[0].cap).toBe(Math.floor(12.5 * (2 + 18 / 6)) + 1)
    })

    it('makes a text that ran to its cap again, alone, under its own cap', async () => {
      const inputs = ['t4', 'a much longer line']
      const out = await run('runaway', path.join(TMP, 'cache-runaway'), undefined, 't4:2', inputs)
      expect(out).toHaveLength(2)
      const entries = read(log('runaway'))
      const cap = (text: string) => Math.floor(12.5 * (2 + text.length / 6)) + 1
      // The batch's cap is the longer text's; the retries use t4's own
      expect(entries.filter((e) => e.batch).map((e) => [e.batch, e.cap])).toEqual([
        [inputs, cap(inputs[1]!)], [['t4'], cap('t4')], [['t4'], cap('t4')],
      ])
      expect(entries.filter((e) => e.write).map((e) => e.write)).toEqual(inputs.map((t, i) => [`clone-${i}.wav`, t]))
    })

    it('gives up on a text that runs to its cap three times', async () => {
      const err = await run('runaway-fail', path.join(TMP, 'cache-runaway-fail'), undefined, 't4:3').catch((e) => e)
      expect(err.name).toBe('QwenSidecarError')
      expect(err.message).toMatch(/no end of speech in 3 tries: 't4'/)
      // t3 finished before t4 failed
      expect(err.partial.clone.map((w: { index: number }) => w.index)).toEqual([0, 1, 2, 3])
    })

    it('caches the batches finished before a failure, so a rerun makes only the rest', async () => {
      const cacheDir = path.join(TMP, 'cache-partial')
      const err = await run('partial-fail', cacheDir, 2).catch((e) => e)
      expect(err.name).toBe('QwenSidecarError')
      expect(err.partial.clone).toHaveLength(6)
      // Cached only: no per-line copies are left in the work dir
      expect(fs.readdirSync(path.join(TMP, 'work-partial-fail')).filter((f) => f.endsWith('.mp3'))).toEqual([])
      await run('partial-rerun', cacheDir)
      expect(read(log('partial-rerun')).filter((e) => e.batch).map((e) => e.batch)).toEqual([['t6']])
    })
  })

  it('rejects a batch size that is not a positive integer', () => {
    const voiceSample = makeVoiceSample(TMP)
    expect(() => QwenTtsProvider({ mode: 'clone', voiceSample, refText: 'Welcome', batchSize: 0 })).toThrow(/batchSize/)
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
      'results = {"ok": True}',
      'for i, _ in enumerate(req["clone"]["texts"]):',
      '    p = f"{work}/clone-{i}.wav"',
      '    with wave.open(p, "wb") as w:',
      '        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)',
      '        w.writeframes(struct.pack("<" + "h" * 1000, *([0] * 1000)))',
      '    print(json.dumps({"event": "wav", "index": i, "path": p}), flush=True)',
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
