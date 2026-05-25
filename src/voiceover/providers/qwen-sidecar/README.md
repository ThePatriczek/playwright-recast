# Qwen3-TTS sidecar

Python sidecar invoked by `QwenTtsProvider`. Reads a single JSON request from
stdin, generates voice-design and/or voice-clone audio, writes WAV files into
the request's `workDir`, and prints a single JSON response on stdout.

## Requirements

- Python 3.10+
- CUDA-capable GPU (≥ 8 GB VRAM for the 1.7B design model; ≥ 4 GB for the
  0.6B clone model)
- An `HF_TOKEN` in the environment if downloading gated Qwen weights

## Install

The deps (PyTorch + flash-attn + Qwen) are ~5–8 GB. Recommended pattern is
**one shared venv reused across projects**:

```bash
python3 -m venv ~/.venvs/playwright-recast
~/.venvs/playwright-recast/bin/pip install -r requirements.txt
```

When invoked from `QwenTtsProvider`, point `pythonBin` at it — absolute
path, no shell activation needed:

```typescript
QwenTtsProvider({
  mode: 'clone',
  voiceSample: './ref.wav',
  refText: 'Sample transcript.',
  pythonBin: `${process.env.HOME}/.venvs/playwright-recast/bin/python3`,
})
```

`flash-attn` requires CUDA toolchain at build time. If the precompiled wheel
is unavailable for your environment, follow the install instructions at
<https://github.com/Dao-AILab/flash-attention>.

## Manually invoke (debugging)

```bash
echo '{"workDir":"/tmp/qwen","device":"cuda:0","dtype":"bfloat16","language":"English","cloneModel":"Qwen/Qwen3-TTS-12Hz-0.6B-Base","clone":{"refAudio":"/path/ref.wav","refText":"Welcome","texts":["hello"]}}' \
  | python3 sidecar.py
```

The provider in `qwen.ts` is the canonical caller.
