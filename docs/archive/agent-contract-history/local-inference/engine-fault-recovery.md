# Engine-fault recovery and device-wedge escalation — evidence

Supports `docs/agents/local-inference.md` § "LOCAL LLM ARCHITECTURE". Read
before widening or narrowing `ENGINE_FAULT_PATTERN`, removing the single
retry, or dropping the `engineReset` escalation. The ONNX-Runtime markers that
carry no "gpu" substring, and the transformers.js tensor-disposal leak
(huggingface/transformers.js#860), are why both exist.

## Original text

   - Engine-fault recovery (llm-host-runtime.tsx): a generate-stage GPU fault
     (narrow `ENGINE_FAULT_PATTERN` — high-signal substrings only) disposes the
     engine and RETRIES the generation ONCE, announced via a 'stage' progress
     report + logs (never silent). A fault that survives the retry reports the
     visible "engine was reset" error. Aborts never trigger recovery.
     `ENGINE_FAULT_PATTERN` also matches the ONNX-Runtime GPU-memory-exhaustion
     markers that carry NO "gpu" substring (`ortrun`/`bad_alloc`/`safeint`/
     `integer overflow`): prefilling a prompt larger than the device's WebGPU
     memory aborts ORT with one of those, and without matching them a single
     overflowed tool turn poisons local chat for the whole session.
   - Device-wedge escalation (engineReset flag): disposing the ORT session is
     NOT enough for a GPU-memory fault — it wedges the whole WebGPU DEVICE, and a
     transformers.js tensor-disposal leak (huggingface/transformers.js#860)
     keeps the leaked buffers alive, so the next generation reloads into a dead
     device. The renderer sets `LlmHostErrorDetails.engineReset` on the recovery
     error report; `LlmHostManager` escalates to a debounced host-window
     `reset()` (a fresh device) so the NEXT message recovers automatically. Only
     persistent faults (dispose+retry already failed) flag it, so it is not
     over-aggressive. Proof: llm-host-runtime.test.tsx + llm-host-manager.test.ts.
