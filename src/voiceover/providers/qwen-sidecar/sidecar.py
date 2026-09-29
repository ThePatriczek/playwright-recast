"""Qwen3-TTS sidecar.

Reads one JSON request from stdin, generates audio, writes one JSON
response to stdout. See README.md and ../qwen.ts for the protocol.
"""
import json
import sys
import traceback

stage = "init"
results = {"ok": True}

try:
    # Imports inside the try block so missing Python deps (ImportError) and
    # bad request JSON both surface via the structured 'init' error channel.
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    req = json.loads(sys.stdin.read())
    work_dir = req["workDir"]
    device = req["device"]
    dtype_name = req["dtype"]
    language = req["language"]
    torch_dtype = getattr(torch, dtype_name)

    if "design" in req:
        stage = "design"
        d = req["design"]
        model = Qwen3TTSModel.from_pretrained(
            d["designModel"],
            device_map=device,
            dtype=torch_dtype,
            attn_implementation="flash_attention_2",
        )
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
        model = Qwen3TTSModel.from_pretrained(
            req["cloneModel"],
            device_map=device,
            dtype=torch_dtype,
            attn_implementation="flash_attention_2",
        )
        # In batches: GPU memory grows with the texts per call, and one call
        # for every new line of a long screencast ran out of it.
        texts = c["texts"]
        batch_size = c.get("batchSize", 8)
        # The reference audio once, not again for every batch.
        prompt = model.create_voice_clone_prompt(ref_audio=c["refAudio"], ref_text=c["refText"])
        # Filled per batch, so a failure still reports the finished ones.
        results["clone"] = []
        for start in range(0, len(texts), batch_size):
            wavs, sr = model.generate_voice_clone(
                text=texts[start:start + batch_size],
                language=language,
                voice_clone_prompt=prompt,
            )
            for offset, wav in enumerate(wavs):
                p = f"{work_dir}/clone-{start + offset}.wav"
                sf.write(p, wav, sr)
                results["clone"].append({"path": p})
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
        **{k: results[k] for k in ("design", "clone") if k in results},
    }))
    sys.exit(1)
