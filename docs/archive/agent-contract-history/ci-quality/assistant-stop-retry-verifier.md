# Assistant stop/retry verifier — evidence

Supports `docs/agents/ci-quality.md` § "Assistant stop/retry verifier"
(BST-1728). Read this before changing or weakening
`apps/web/e2e/assistant-panel-interactions.test.ts`. The contract holds the
rules; this file is the record of what the test proves and how it was falsified.

`apps/web/e2e/assistant-panel-interactions.test.ts` selects the browser-local
model and injects a controlled `LocalLlmBackend` at the web app's existing
backend factory. The explicit fixture is restricted to webdriver automation;
ordinary sessions still lazily load the native Gemma backend. The test asserts
that `window.llmHost` is absent: adding this desktop bridge would exercise an
unreachable hybrid of the web transport and desktop host adapter.

The real browser adapter must supply streaming callbacks and an AbortSignal.
The fixture streams cumulative text snapshots, and Stop must abort the signal
owned by that generation. Regenerate uses the current accessible name
(`Regenerate response`), starts a distinct generation with the original prompt,
and finishes with the complete text (not an appended delta). That completed
generation must never enter the cancelled set. A long response is stopped the
same way. No provider key, model download, conditional action, sleep, retry or
availability skip is needed.

Before weakening these assertions, repeat the manual falsification procedure:
disconnect the adapter's AbortSignal from backend generation, verify failure,
then restore it and verify the test passes. UI visibility alone is insufficient
evidence of cancellation.
