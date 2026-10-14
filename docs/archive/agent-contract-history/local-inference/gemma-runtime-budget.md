# Gemma 4 E2B GPU prompt ceiling and runtime budget — evidence

Supports `docs/agents/local-inference.md` § "LOCAL LLM ARCHITECTURE". Read
before changing the declared local context window or output cap.

CORRECTION (verified 2026-09-21): the original text located the declaration in
`packages/assistant-contract/src/provider-registry.ts`. That module holds the
types and parses the catalog; the values themselves
(`contextWindow: 8192`, `maxOutputTokens: 2048`) are the built-in `local`
provider's model entry in `packages/assistant-contract/src/provider-catalog.json`,
which carries its own `_note` explaining the divergence. The DB model-catalog
row (`packages/db/src/migrations/028-gemma-local-llm.ts`) still declares the
descriptive `capabilities.contextWindow: 131072`; that value is intentionally
not consulted for budgeting, so the two diverging is harmless.

## Original text

   - GPU prompt ceiling: the q4f16 Gemma 4 E2B WebGPU runtime OOMs at prompts in
     the low thousands of tokens (≈3-4K on a typical device — far below the
     architectural ~128K). Gemma 4 E2B is therefore declared at the RUNTIME
     budget `contextWindow: 8192` / `maxOutputTokens: 2048` in
     packages/assistant-contract/src/provider-registry.ts (NOT the architectural
     window) so the context-budget machinery + meter keep assembled prompts in
     the working zone; the engineReset escalation handles the residual
     device-dependent overflow. A leaner local system-prompt/tool-schema
     footprint is the deeper follow-up for reliable local tool-calling.
