# Lost test file reporter and the V8 WASM teardown fatal — evidence

Supports `docs/agents/ci-quality.md` § "A test file with no verdict fails the
lane" (BST-1221). Read this before changing `LostTestFileReporter`,
`scripts/run-test-command.mjs`, the Node toolchain pin, or PGlite test-fixture
ownership, and when a lane reports `Test Files N passed (N+1)` or
`BRAINSTRIKE_CI_VERDICT=V8_WASM_JIT_TEARDOWN_FATAL`. The contract holds the
rules; this file is the record of why.

Every package/app `vitest.config.mts` registers `LostTestFileReporter`
(`packages/test-utils/vitest-lost-file-reporter.mjs`), enforced across the
workspace by `scripts/verify-lost-file-reporter.mjs` and its paired test
(corrected: packages in the `tooling` domain of `architecture/domain-map.json`
are exempt, because that domain may not depend on `test-utils`). A new
package's config is a violation until it opts in — the guarantee is per-config
and would otherwise be lost silently by omission.

**What it defends against.** A worker can die mid-run without unwinding: a V8
fatal (`Check failed: jit_page_->allocations_.erase(addr)` →
`ThreadIsolation::UnregisterWasmAllocation` → `V8_Fatal`) or an OOM kill. The
file that worker held reports nothing. Measured on vitest 4.1.10:

- the lost module IS present at `onTestRunEnd`, with `state() === 'pending'`;
- the run's own verdict is **`reason: 'passed'`**;
- the summary reads `Test Files 2 passed (3)` — PASS phrasing whose only tell is
  a parenthesised total that does not match;
- the process exits non-zero ONLY via the separate unhandled-errors channel
  (`[vitest-pool]: Worker exited unexpectedly`).

That last point is why the reporter exists rather than trusting the exit code.
The non-zero exit is not a property of the results; it is a side effect of an
error channel that `dangerouslyIgnoreUnhandledErrors: true` switches off.
Control-tested: with that one flag set, a run that dropped an entire test file
exits **0** and reads fully green. With the reporter registered the same run
exits **1** and names the file. `--reporter` on the CLI OVERRIDES config
`reporters`, so a lane that passes its own `--reporter` drops this guard unless
it names the reporter module too. (Corrected: this is now enforced —
`scripts/verify-lost-file-reporter.mjs` fails any package script that passes
`--reporter=` to vitest without
`--reporter=@brainstrike/test-utils/vitest-lost-file-reporter`, and the DB
`--reporter=blob` coverage shard script carries it.)

**Concurrency tuning is NOT a mitigation for this one.** Unlike BST-1072 above,
which was memory pressure and was genuinely fixed by serialization, two of the
observed BST-1221 hits landed in lanes that were ALREADY serialized to a single
worker — `@brainstrike/embeddings#test:integration` (`--maxWorkers=1
--no-file-parallelism`, 2026-08-16, red main) and the desktop unit lane (same
flags, 2026-08-18). Do not "fix" BST-1221 by lowering worker counts; the
evidence disproves worker-count reduction as a fix. The reporter detects the
failure; it does not correct the runtime defect or permit merging with it.

**Runtime correction and qualification (BST-1221, 2026-09-11).**
The Node 24.20.0 Linux x64 stack from PR #3137 resolves through
`WasmImportWrapperCache::Free`, `WasmCodeRefScope::~WasmCodeRefScope`, and
`Runtime_TierUpWasmToJSWrapper`. V8's
[dying-wrapper reference fix](https://github.com/v8/v8/commit/9b8ca54d5a6b6c615eb7ad6d9e2bdca7f8cb1a81)
replaces reference acquisition before the dying-state check with atomic
`AddRefIfNotDying`. Node 24.20.0 and 24.21.0 retain the unsafe order; Node
26.8.2 contains the corrected reference handling and subsequent wrapper
ownership changes. The repository pins Node 26.8.2 for development and CI.
The matching `devEngines.runtime` declaration makes pnpm scripts use that
checksum-locked executable even when invoked by a hosted builder's older Node.
Root/web and MCP package installation ranges admit the bounded Node 24 application/hosting
major and Node 26 tooling major; the managed script runtime remains exactly 26.
Vercel Functions currently supports Node 24, not 26. Its separate stateless
hosted-web entrypoint excludes PGlite and browser-local model inference; validate
the generated function runtime and deployed routes when changing this boundary.
Browser-local WASM executes in the browser engine, not the function runtime.
Electron retains its own bundled Node/V8; changing `.nvmrc` does not upgrade
Electron's runtime. Shared production code keeps Node 24 declarations matching
Electron's Node API surface, while the build and test executable uses Node 26.
The MCP packages also run inside that application and retain the bounded Node 24
consumer arm. Tooling-only source uses the same conservative types catalog;
new tooling APIs require an explicit compatible design, not a cast around it.
`apps/desktop/package.json#config.nodeRuntimeMajor` declares that API floor;
the required real Electron native smoke test compares both the declaration and
the installed typings with `process.versions.node`. The static alignment guard
checks the toolchain and production API floor separately, preventing Node
26-only APIs from compiling into the Node 24 application runtime.

The exact toolchain patch is intentional: local and CI qualification must name
the same executable. React Doctor also receives this explicit Node version:
its composite action otherwise installs Node 24, whose npm rejects the managed
Node 26 declaration before scanning. The paired action-version contract guards
that input against `.nvmrc`. Any added composite action that runs npm/npx
from the workspace must select the managed Node version too; its private
default does not inherit the surrounding job setup. Updating the pin requires qualifying the replacement;
future patch releases must not be assumed to have passed this evidence.
The DB unit project explicitly includes `__tests__/**/*.test.ts` without an
integration-suffix exclusion (unlike some other package scripts). It runs
100 startup/query/close cycles as a persistent
runtime canary. Its existing 10-second per-case timeout and two-worker CI cap
remain unchanged. A lost file fails; only the complete three-marker signature
below is classified as the V8 fatal, so an ordinary OOM is not mislabeled.

Source correspondence identifies a correction candidate, not proof that an
intermittent crash has disappeared. Qualification requires repeated affected
workloads on the affected Linux x64 platform, preservation of every outcome,
exact-head required checks, and replacement-main verification. A single passing
run, passing rerun, or macOS ARM64-only test is insufficient. Any recurrence
blocks completion and requires investigation; no quarantine, skip, or accepted
runtime-defect exception applies.

**Historical fixture changes, not a runtime fix (2026-08-26).**
Sharing a PGlite instance reduced instantiate/teardown churn in
`embedding-queue-load.integration.test.ts`; later crashes, including #3137,
disproved this as a complete correction. Earlier claims that this isolated the
dominant trigger or proved a PKU-specific cause exceeded the evidence.
`--no-memory-protection-keys` was tried and disproven (2026-08-22). Preserve
correct fixture ownership, but do not substitute reduced workload for fixing
the runtime.

**In-memory fixture ownership (BST-1221, 2026-09-05).**
`wasmLoader.createPGlite('memory://...')` returns an uncached handle;
`closeCached(dataDir)` cannot close it. Assistant-data fixtures must use
`src/__tests__/helpers/test-pglite.ts`, which registers direct handle cleanup
with Vitest's `onTestFinished`. It also respects a handle explicitly closed by
a migration test's `finally` block. The real runner regression in
`test-pglite-lifecycle.integration.test.ts` observes both owned databases after
cleanup and fails if either remains open. The fixture keeps a fresh database
per test; it does not share mutable state, lower concurrency, or suppress the
native-fatal/lost-file guards. The app-shell analytics and desktop live-usage
fixtures likewise close their returned handles directly. The prior teardown leaked the in-memory handles
and relied on process/GC cleanup under repeated WASM initialization pressure.

The required Unit test and integration steps additionally run through
`scripts/run-test-command.mjs`. The wrapper streams stdout/stderr unchanged,
preserves the command's exit status except that a classified fatal fails the
lane even if the wrapped command exited zero, and recognizes only the complete
three-marker native signature in one bounded output region: the exact
`jit_page_` allocation assertion, `V8_Fatal`, and
`ThreadIsolation::UnregisterWasmAllocation`. When all three are
present it emits the machine-readable
`BRAINSTRIKE_CI_VERDICT=V8_WASM_JIT_TEARDOWN_FATAL` verdict with explicit
BST-1221 guidance. A generic worker exit, lost file, assertion failure, or
partial V8 text is not classified as this defect. This is deliberately not a
retry or suppression: the required lane stays red, but the native fatal can no
longer be mistaken for an ordinary test assertion or a resolved rerun.
