import json
import os
import wave


def write(path, data, sample_rate):
    with open(os.environ["QWEN_STUB_LOG"], "a") as f:
        f.write(json.dumps({"write": [os.path.basename(path), data]}) + "\n")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        # A real rate, whatever the stub model claims: ffmpeg reads this file
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * 2400)
