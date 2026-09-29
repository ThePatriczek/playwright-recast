import json
import os


def _log(entry):
    with open(os.environ["QWEN_STUB_LOG"], "a") as f:
        f.write(json.dumps(entry) + "\n")


class Qwen3TTSModel:
    batches = 0

    @classmethod
    def from_pretrained(cls, name, **kwargs):
        return cls()

    def create_voice_clone_prompt(self, ref_audio, ref_text):
        _log({"prompt": [ref_audio, ref_text]})
        return [{"ref_text": ref_text}]

    def generate_voice_clone(self, text, language, voice_clone_prompt):
        if str(Qwen3TTSModel.batches) == os.environ.get("QWEN_STUB_FAIL_BATCH"):
            raise RuntimeError("CUDA out of memory")
        Qwen3TTSModel.batches += 1
        _log({"batch": text})
        # The "wav" is the text, so soundfile.write can log which file got which
        return list(text), 24000
