# SemanticRecall WASM allocation evidence

Supports `docs/agents/mastra-boundary.md` § "First-class subagents: host lifetime decision".

The old filename is retained for existing links. Historical desktop reports
associated repeated xxhash instances with WASM exhaustion. Those reports do not
by themselves prove retained-memory leakage in the current release.

The current 1.71.0 probe is
`packages/agent/src/__tests__/semantic-recall-lifecycle.integration.spec.ts`.
Four Agents run eight turns each against real engine-configured PGlite, the
production memory adapter, deterministic embeddings and native processors. It
checks 64 persisted messages and retrieval outside the two-message history
window. It uses no private processor fields or invalid fake constructor options.

Before the hasher repair, 32 turns created **160 WebAssembly instances**. After
lazy sharing of the stateless hasher, the same probe creates **one**. Initialization
failure still rejects, and a failed initialization is not cached permanently.
The old private-field allocation test is replaced by this stronger public
lifecycle test with the same at-most-one allocation assertion.

Observed RSS deltas in the single matched local runs were 13,598,720 bytes before
and 8,093,696 after; array-buffer deltas were 1,761,370 and 1,677,406. These noisy
whole-process measurements are recorded, not asserted as memory savings or leak
proof. The demonstrated defect and patch reason is repeated WASM initialization
in normal supported memory use. Remove the hunk when an upstream version passes
the public allocation-and-behavior regression.
