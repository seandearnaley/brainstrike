# Desktop assistant setup promise ownership — evidence

Supports `docs/agents/ci-quality.md` § "Desktop assistant setup promise
ownership" (BST-1639). Read this before changing `setupAssistantMock` in
`apps/desktop/e2e/utils/assistant-mock.ts`, or the desktop Playwright artifact
upload paths. It records the garbage-collected-promise smoke failure, the lost
trace, and the V8 inspector behaviour behind the ownership rule.

`apps/desktop/e2e/utils/assistant-mock.ts` separates asynchronous credential
persistence from synchronous renderer configuration. The pending write has an
explicit, scoped owner: `evaluateHandle` returns a remote object containing
**both the original write promise and its tagged completion**. Observe rejection
in the same renderer turn as `saveKey`; attaching the first rejection handler in
a later CDP command produces an unhandled-rejection event for an immediately
rejected write. Await the tagged completion, propagate the original rejection
or structured write failure, and dispose the handle in `finally` before
configuring the renderer. A missing write bridge is a visible failure. Never
substitute retries, a global promise pin, or a timeout increase.

The original smoke failure occurred during the second assistant setup, after
the folder fixture's thread-seeding reload. Its trace was created but never
uploaded: the workflow looked in `test-results` while desktop Playwright writes
to `blob-report`. Both required desktop smoke lanes and both nightly desktop
uploads now target `apps/desktop/blob-report/`, matching the already-correct
packaged MCP uploader.
Both Playwright test attachments (`outputDir`) and its blob reporter use that
directory. Uploaders warn if it is missing: `failure()` also covers setup/build
failures before Playwright has run, when no test artifacts exist. This absence
prevents reconstructing the precise GC schedule in that historical execution.

The controlled regression in `assistant-panel.desktop.test.ts` invokes the
public `setupAssistantMock` helper in an isolated Electron renderer, with a
collectible pending writer and explicit `HeapProfiler.collectGarbage`. The
pre-fix helper reproduces `Resulting promise was garbage collected`; the owned
write survives until settlement. Public JSHandle instrumentation verifies that
disposal completes on every outcome and that the released handle is unusable
while its renderer remains responsive; the test does not demand that V8 reclaim
a released object by a deadline. A missing-disposal negative control fails this
contract. It also
covers delayed and immediate rejection, structured failure, and navigation,
including the absence of unhandled renderer errors. The regular assistant and
folder specs continue to exercise the real frozen preload bridge and complete
product workflows. The isolated writer does not replace the production bridge.

Electron 43's V8 inspector holds awaited evaluation results weakly; see
[V8's promise-lifetime fix and regression](https://github.com/v8/v8/commit/5177b10891e65108c1a19dfc56bff4e58d79d216).
Retaining an outer async wrapper alone does not retain the promise it awaits,
so an Electron upgrade is not a substitute for testing this helper's ownership
boundary. The upload pairing is guarded by
`scripts/__tests__/desktop-smoke-artifacts-contract.test.mjs`.
