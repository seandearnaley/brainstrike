# Built-in local provider entrypoints — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". The browser-only local language-model factory registration and the local tool-call argument validator.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 76-97); append rather than
rewrite.

---

- Built-in local provider:
  - Desktop/web local inference targets `onnx-community/gemma-4-E2B-it-ONNX` only.
  - No silent fallback to WASM. If WebGPU is unavailable, the built-in local provider is unavailable.
  - DESKTOP runs local chat through the assistant server's real Mastra loop
    (persistence, run events, tool guards); inference is proxied to the hidden
    llm-host. The built-in local model is also selectable as the observational
    memory model and local embedders as the semantic recall embedder — all
    keyless. See LOCAL LLM ARCHITECTURE.
  - Local tool-call arguments must parse as a root JSON object before a
    provider tool-call part is emitted. Gemma normalization and the hidden-host
    provider projection share the same validator. A malformed call terminates
    generation with `local_tool_call_arguments_invalid`, bounded diagnostics,
    and no approval snapshot; it is never repaired from raw text or coerced to
    `{}`. Valid arguments are canonicalized before Mastra sees them.
  - The broad `@brainstrike/agent` entrypoint explicitly registers the
    browser-only in-process local language-model factory. Server-safe subpaths,
    especially `@brainstrike/agent/hosted-web`, must never import or register
    that Transformers/Hugging Face graph. Selecting the in-process `local`
    provider without first importing the broad root entrypoint fails visibly;
    the Desktop hidden-host client path remains available without that browser
    factory. Do not make local-provider behavior depend on an undocumented
    narrow-entrypoint import order.
