# SemanticRecall xxhash-wasm leak — evidence

Supports `docs/agents/mastra-boundary.md` § "First-class subagents: host lifetime
decision". Read this before removing the xxhash hunk from
`patches/@mastra__core@1.64.0.patch` or when diagnosing "Cannot allocate Wasm
memory for new instance" in a long desktop session.

The core patch also shares ONE xxhash-wasm instance across every
`SemanticRecall` (settled 2026-09-15, proven upstream defect, present on
1.66.0 and `main`, reported upstream): `SemanticRecall` initialized
`hasher = xxhash()` per instance while `MastraMemory.getInputProcessors` and
`getOutputProcessors` construct a new `SemanticRecall` on every model step, so
each step was a fresh `WebAssembly.instantiate` holding a V8 guard-region
reservation. A WebAssembly probe on the desktop main process counted 139
instantiations in one four-specialist turn; across a session the process
exhausted V8's WebAssembly budget and EVERY later instantiation failed with
"Cannot allocate Wasm memory for new instance" — the retrieval tool, message
persistence and the memory observer died with it (thread-debug pack
2026-09-15T02-25-01Z; the failing call is the one from the embedding host's
error, rebuilt frameless by `deserializeRuntimeError`, which misled a first
diagnosis toward the embedding host). Paired:
`mastra-semantic-recall-hasher.spec.ts` (25 instances, at most one
instantiation; 25 without the hunk). Remove the hunk when upstream memoizes the
hasher or the processor.
