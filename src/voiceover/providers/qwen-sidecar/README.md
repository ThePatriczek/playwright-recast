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
python3 -m venv ~/.venvs/qwen-tts
~/.venvs/qwen-tts/bin/pip install -r requirements.txt
```

When invoked from `QwenTtsProvider`, point `pythonBin` at it — absolute
path, no shell activation needed:

```typescript
QwenTtsProvider({
  mode: 'clone',
  voiceSample: './ref.wav',
  refText: 'Sample transcript.',
  pythonBin: `${process.env.HOME}/.venvs/qwen-tts/bin/python3`,
})
```

Alternatives:

- **`uv`** — `uv venv ~/.venvs/qwen-tts && uv pip install -p ~/.venvs/qwen-tts/bin/python -r requirements.txt`. Hardlinks from a global store, so even per-project venvs are nearly free on disk.
- **Per-project `.venv`** — `python3 -m venv .venv` for full isolation; costs ~5–8 GB/project without `uv`.
- **Conda** — same idea; pass the env's `bin/python3` to `pythonBin`.

`flash-attn` requires CUDA toolchain at build time. If the precompiled wheel
is unavailable for your environment, follow the install instructions at
<https://github.com/Dao-AILab/flash-attention>.

## Manually invoke (debugging)

```bash
echo '{"workDir":"/tmp/qwen","device":"cuda:0","dtype":"bfloat16","language":"English","cloneModel":"Qwen/Qwen3-TTS-12Hz-0.6B-Base","clone":{"refAudio":"/path/ref.wav","refText":"Welcome","texts":["hello"]}}' \
  | python3 sidecar.py
```

The provider in `qwen.ts` is the canonical caller.
