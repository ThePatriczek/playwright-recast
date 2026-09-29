Stub `qwen_tts`, `torch` and `soundfile` modules, so `qwen.test.ts` can run
the real `sidecar.py` on `PYTHONPATH` without a GPU. `qwen_tts` logs every
call to `QWEN_STUB_LOG` and raises on batch `QWEN_STUB_FAIL_BATCH` (0-based).
