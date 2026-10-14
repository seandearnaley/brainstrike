# Local-runtime fetch receiver — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". Why `fetchImpl` is read into a local and the ambient default bound at capture, and why a `vi.fn()` mock cannot cover it.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 36-54); append rather than
rewrite.

---

- **Local-runtime HTTP goes through `fetchJsonWithTimeout`, and its `fetchImpl`
  MUST NOT be invoked as a property of the options bag.** `options.fetchImpl(...)`
  makes `this` the options object, and the browser's native `fetch` rejects any
  receiver that is not the global object with
  `Failed to execute 'fetch' on 'Window': Illegal invocation` — the request
  never leaves the browser, so a probe fails identically whether or not a daemon
  is listening. That shipped once (BST-964): Ollama and LM Studio reported
  `Unavailable` even while running. Read the impl into a local first, and bind
  the ambient default at capture (`globalThis.fetch?.bind(globalThis)`) in
  `LocalRuntimeDiscoveryService` and `LocalRuntimeModelCatalogService`.
  Measured: a BARE call on an unbound reference is fine (`this` is `undefined`
  and the engine tolerates it) — only a PROPERTY call breaks, which is why the
  bare-call `fetch` captures elsewhere in the repo are unaffected.
  A `vi.fn()` mock can never catch this: a plain function is indifferent to its
  receiver. Regression cover must be receiver-aware — see
  `packages/local-runtime/src/__tests__/local-runtime-fetch-receiver.test.ts`,
  which uses both a receiver-sensitive and a receiver-recording fetch (the
  latter is what pins the bind; the former cannot, since it tolerates
  `undefined`).
