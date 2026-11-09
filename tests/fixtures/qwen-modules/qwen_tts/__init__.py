import json
import os


def _log(entry):
    with open(os.environ["QWEN_STUB_LOG"], "a") as f:
        f.write(json.dumps(entry) + "\n")


SAMPLE_RATE = 24000
FRAMES_PER_SECOND = 12.5


class Qwen3TTSModel:
    batches = 0
    runaways = 0

    @classmethod
    def from_pretrained(cls, name, **kwargs):
        _log({"load": name})
        return cls()

    def create_voice_clone_prompt(self, ref_audio, ref_text):
        _log({"prompt": [ref_audio, ref_text]})
        return [{"ref_text": ref_text}]

    def generate_voice_clone(self, text, language, voice_clone_prompt, max_new_tokens):
        if str(Qwen3TTSModel.batches) == os.environ.get("QWEN_STUB_FAIL_BATCH"):
            raise RuntimeError("CUDA out of memory")
        Qwen3TTSModel.batches += 1
        _log({"batch": text, "cap": max_new_tokens})
        # The "wav" is the text, padded to a plain reading speed of 15 characters
        # per second, so soundfile.write can log which file got which.
        # QWEN_STUB_RUNAWAY names a text whose first N generations run to the
        # cap ("text:N"), as many samples long as the real model's would be.
        return [self._generate(t, max_new_tokens) for t in text], SAMPLE_RATE

    def _generate(self, text, cap):
        runaway, _, times = os.environ.get("QWEN_STUB_RUNAWAY", "").partition(":")
        if text == runaway and Qwen3TTSModel.runaways < int(times):
            Qwen3TTSModel.runaways += 1
            return "~" * int((cap - 1) * SAMPLE_RATE / FRAMES_PER_SECOND)
        return text.ljust(int(SAMPLE_RATE * len(text) / 15))
