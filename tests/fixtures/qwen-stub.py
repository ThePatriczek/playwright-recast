"""Stub sidecar used by qwen.test.ts.

Mimics the real protocol: reads request JSON from stdin, writes short
silence WAVs to the requested workDir, prints a response on stdout.
Has no torch/qwen-tts dependency.

Supports env vars for failure injection:
  QWEN_STUB_FAIL_STAGE = init|design|clone  -> emit error response at that stage
"""
import json
import os
import struct
import sys
import traceback
import wave


def write_silence_wav(path: str, duration_sec: float = 0.5, sample_rate: int = 24000) -> None:
    n_samples = int(duration_sec * sample_rate)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(sample_rate)
        w.writeframes(struct.pack("<" + "h" * n_samples, *([0] * n_samples)))


fail_stage = os.environ.get("QWEN_STUB_FAIL_STAGE")
stage = "init"
results = {"ok": True}

try:
    if fail_stage == "init":
        raise RuntimeError("stub init failure")

    req = json.loads(sys.stdin.read())
    work_dir = req["workDir"]

    if "design" in req:
        stage = "design"
        if fail_stage == "design":
            raise RuntimeError("stub design failure")
        path = f"{work_dir}/design.wav"
        write_silence_wav(path)
        results["design"] = {"path": path}

    if req.get("clone", {}).get("texts"):
        stage = "clone"
        if fail_stage == "clone":
            raise RuntimeError("stub clone failure")
        clone_results = []
        for i, _text in enumerate(req["clone"]["texts"]):
            p = f"{work_dir}/clone-{i}.wav"
            write_silence_wav(p)
            clone_results.append({"path": p})
        results["clone"] = clone_results

    print(json.dumps(results))
except Exception as e:
    print(json.dumps({
        "ok": False,
        "stage": stage,
        "error": str(e),
        "traceback": traceback.format_exc(),
    }))
    sys.exit(1)
