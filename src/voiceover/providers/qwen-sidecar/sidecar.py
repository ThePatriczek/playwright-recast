"""Qwen3-TTS sidecar.

Reads one JSON request from stdin, generates audio, and writes JSON lines to
stdout: one `{"event": "wav", "index", "path"}` per clone WAV as it finishes,
then the response. See README.md and ../qwen.ts for the protocol.

`--preload '{"model", "device", "dtype"}'` loads that model before reading
the request, so it loads while the caller is still preparing the texts.
"""
import json
import sys
import traceback

stage = "init"
results = {"ok": True}

# The codec's frame rate: a sample that runs to max_new_tokens is
# (max_new_tokens - 1) frames long.
FRAMES_PER_SECOND = 12.5
# A sample that misses its end of speech babbles until max_new_tokens, holding
# its whole batch (the model's default cap, 8192, is 11 minutes of audio).
# The cap allows ~2.5x a plain reading speed of 15 characters per second.
CAP_SECONDS_BASE = 2
CAP_CHARS_PER_SECOND = 6
RUNAWAY_TRIES = 3


def frame_cap(text):
    return int(FRAMES_PER_SECOND * (CAP_SECONDS_BASE + len(text) / CAP_CHARS_PER_SECOND)) + 1


def ran_away(wav, sr, text):
    """At or past its own text's cap, also in a batch whose cap a longer text set."""
    return len(wav) >= (frame_cap(text) - 1) * sr / FRAMES_PER_SECOND


def emit(line):
    print(json.dumps(line), flush=True)

try:
    # Imports inside the try block so missing Python deps (ImportError) and
    # bad request JSON both surface via the structured 'init' error channel.
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    preloaded = {}

    def load(name, device, dtype_name):
        key = (name, device, dtype_name)
        if key in preloaded:
            return preloaded.pop(key)
        return Qwen3TTSModel.from_pretrained(
            name,
            device_map=device,
            dtype=getattr(torch, dtype_name),
            attn_implementation="flash_attention_2",
        )

    if len(sys.argv) > 2 and sys.argv[1] == "--preload":
        p = json.loads(sys.argv[2])
        try:
            preloaded[(p["model"], p["device"], p["dtype"])] = load(p["model"], p["device"], p["dtype"])
        except Exception:  # noqa: BLE001 — the stage that needs it loads it again and reports the error
            torch.cuda.empty_cache()

    req = json.loads(sys.stdin.read())
    work_dir = req["workDir"]
    device = req["device"]
    dtype_name = req["dtype"]
    language = req["language"]

    if "design" in req:
        stage = "design"
        d = req["design"]
        model = load(d["designModel"], device, dtype_name)
        wavs, sr = model.generate_voice_design(
            text=[d["refText"]],
            language=language,
            do_sample=False, top_p=1.0, num_beams=1,
            instruct=[d["voiceDescription"]],
        )
        design_path = f"{work_dir}/design.wav"
        sf.write(design_path, wavs[0], sr)
        results["design"] = {"path": design_path}
        del model
        torch.cuda.empty_cache()

    if req.get("clone", {}).get("texts"):
        stage = "clone"
        c = req["clone"]
        model = load(req["cloneModel"], device, dtype_name)
        # In batches: GPU memory grows with the texts per call, and one call
        # for every new line of a long screencast ran out of it.
        texts = c["texts"]
        batch_size = c.get("batchSize", 8)
        # The reference audio once, not again for every batch.
        prompt = model.create_voice_clone_prompt(ref_audio=c["refAudio"], ref_text=c["refText"])

        def generate(batch_texts):
            return model.generate_voice_clone(
                text=batch_texts,
                language=language,
                voice_clone_prompt=prompt,
                max_new_tokens=max(frame_cap(t) for t in batch_texts),
            )

        # Shortest first: a batch takes as long as its longest text, so similar
        # lengths pad less, and the first WAVs come back sooner.
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        for start in range(0, len(order), batch_size):
            indices = order[start:start + batch_size]
            wavs, sr = generate([texts[i] for i in indices])
            for i, wav in zip(indices, wavs):
                for _ in range(RUNAWAY_TRIES - 1):
                    if not ran_away(wav, sr, texts[i]):
                        break
                    # Sampling is random: alone, the same text usually ends
                    wav = generate([texts[i]])[0][0]
                if ran_away(wav, sr, texts[i]):
                    raise RuntimeError(f"no end of speech in {RUNAWAY_TRIES} tries: {texts[i]!r}")
                p = f"{work_dir}/clone-{i}.wav"
                sf.write(p, wav, sr)
                emit({"event": "wav", "index": i, "path": p})
            del wavs
            torch.cuda.empty_cache()

    print(json.dumps(results))
except Exception as e:  # noqa: BLE001 — top-level catch is the design
    print(json.dumps({
        "ok": False,
        "stage": stage,
        "error": str(e),
        "traceback": traceback.format_exc(),
        # What finished before the failure, for the caller to cache
        **{k: results[k] for k in ("design",) if k in results},
    }))
    sys.exit(1)
