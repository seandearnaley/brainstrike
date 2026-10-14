# Subagent reference results and continuation decision

Status: option 1 implemented with the user-approved minimal patch policy. Recorded
2026-09-26; delivery review and CI are tracked on PR #3337. The native
continuation replacement was rejected at the reference gate; the existing
production continuation owner is retained and simplified by explicit user decision. No custom child loop
was introduced.

## Demonstrated results

The candidate pins `@mastra/core` 1.71.0 and `@mastra/memory` 1.32.1, the stable
versions verified for this work. It uses an explicit pnpm vendor patch, not an
installed-package monkeypatch. The four logical repairs and removal conditions are recorded in
`docs/archive/agent-contract-history/mastra-boundary/upgrade-1-71.md`.

The native reference proves:

- Concurrent children read, park for write approval, and survive destruction and
  reconstruction of both the parent runtime and PGlite storage. Each approved
  append occurs once. A repeated completed-task resume is rejected.
- Identical repeated child data parts are retained twice in the correct child
  transcript, without a second copy contaminating the parent transcript.
- Cancelling the selected task waits through its held tool `finally` block. The
  selected child does not write, while its same-Agent sibling writes successfully.
- Shutdown waits for workflow deletion. Deletion failure reaches the caller
  without an orphan rejection; an expired cleanup deadline is an error.
- A child's approval suspension does not cause an extra parent inference. A
  parent parked on its own approval is not reinvoked by child completion.

These are scripted-model, real-native-runtime, real-PGlite and real-filesystem
proofs. They are not desktop UI or actual OS-process restart acceptance.

The broader production run passed 39 tests across nine files: live grants,
reconstructed root approvals, rejected admission, active-parent result delivery,
recursive Worker execution, resumed context, child watchdogs, and the production
background worker stream. This run uses the existing host continuation owner.
It does not establish that replacing that owner with native `untilIdle` works.

## Application corrections already integrated in this candidate

- Use the executing public hook's actual input and native call identity, rather
  than searching prompt history for a delegation identity.
- Forward public `suspendedToolRunId` during reconstructed executor resume.
- Replace private manager `taskContexts` inspection with public execution-hook
  observations scoped to the concrete manager instance. The real reconstructed
  parent regression passes; a host binding alone was the wrong lifetime.
- Remove `_skipBgTaskWait`; the already-configured public `waitTimeoutMs: 0`
  covers the required behavior. The 39-test production run passed without it.
- Import PR #3337 and its preserved local review fixes into this candidate.
- Remove the experimental separate child owner classes and storage deletion
  tracker after native cancellation/cleanup demonstrated the necessary joins.

The preserved PR and upgrade worktrees were read but not modified. No recurring
jobs or inherited agent assignments were used.

## Native continuation capability boundary

Reference:
`packages/agent/src/__tests__/delegation-lifecycle.integration.spec.ts`, test
`documents native EOF during a host decision commit, with resume continuing outside that stream`.

Run from `packages/agent`:

```sh
./node_modules/.bin/vitest run src/__tests__/delegation-lifecycle.integration.spec.ts -t 'documents native EOF'
```

The test uses only native Agents, supervisor background configuration, public
`stream(..., { untilIdle: true })`, manager streaming/resume, and public storage.
It performs this controlled sequence:

1. A writer child parks for approval; a reader sibling is still running.
2. The host accepts the writer decision but holds its durable commit. It must not
   execute a write before recording the decision.
3. The reader completes. The native parent continuation finishes and its combined
   stream reaches EOF while the decision commit is still held. No write occurred.
4. The host completes the commit and calls public `manager.resume`.
5. The child writes once and completes on the manager stream. Its completion is
   absent from the original combined stream, and no new parent model call occurs.

The characterization test passes because it establishes this observable API
boundary. It does not count as a passing product acceptance test. Log:
`/tmp/brainstrike-3337-native-approval-boundary.log`.

This is consistent with the documented contract: `untilIdle` closes with no
running tasks or queued completions; a suspended task may resume out of band.
The current public `untilIdle` options expose `maxIdleMs`, not a host decision
reservation. Extending that timeout does not prevent ordinary idle closure.
`sendStreamResume` targets an existing suspended agent run; this parent has
finished and its parked child belongs to the background task manager. It does
not supply a reservation for this boundary.

Sources inspected:

- https://mastra.ai/docs/harness/background-tasks
- https://mastra.ai/docs/subagents
- Installed 1.71.0 public agent/background-task declarations and implementation.

The demonstrated gap is **automatic continuation through an in-flight host
approval commit**, not an inability to run subagents or resume their writes.
The 39 production tests show that the existing host owner supports broader
approval behavior; they do not prove that it is the smallest maintainable design.

## Selected architecture

The user selected option 1: retain and simplify the existing Brainstrike
parent-turn coordinator. Native Agent execution owns both parent and children.
The host owns durable human decision admission and parent continuation after
child results. Both experimental native `untilIdle` policy patches were removed.
No separate child agent loop or scheduler was added.

The coordinator now uses unique reservation tokens in place of counters and
separate epochs, and shares one close/error/cancel cleanup path. A production
integration probe holds the durable decision commit while the last running sibling
finishes, then proves one effect and the final parent outcome on that same stream.
The public reference retains its native capability-boundary characterization;
approval and reconstructed-write acceptance use the selected host coordinator.

The semantic-recall repair is justified by a real 32-turn allocation/recall
regression, replacing private-field inspection. It measures 160 native WASM
hasher instantiations without repair and one with it, while all 64 messages,
indexing, and retrieval of old context pass. This proves allocation churn, not
retained memory exhaustion.

## Migration acceptance

- 3,044 agent unit and 647 integration tests passed; one existing skip each.
- Fourteen real Electron delegated smoke cases passed without retries, covering
  labels, approve/decline, concurrent workers, recursion, renderer reload, actual
  host restart with one write, and selected Stop with siblings continuing.
- Ten failure-critical desktop DB tests and twelve provider-shim tests passed.
- Two additional real Electron regressions passed: command approval/grants/output
  and active-child input/images/context, idle continuation, reload and approval.
- Normal commit hooks passed 106 build/type-check tasks, formatting and secrets.
  Repository static/build/unit/MCP and browser checks passed. After the import
  correction, all 1,447 desktop integration tests passed with one existing skip.
  Required web smoke passed 24 tests; desktop smoke passed 35 with one existing skip.
- The broader run found generated parent memory instructions entering read-only
  children; public message filtering now leaves system authority to the trusted
  context processor. Three integration cases and 41 delegation unit cases pass.
- Idle-child approval after reload exposed a root replay lookup applied to a
  child-owned call. Root discovery now leaves that action to the existing durable
  continuation receipt. Both the HTTP regression and full Electron flow pass.

The repository-wide integration gate exposed an Electron import reaching the
Node process-restart fixtures through the critical-database helper. Scheduler
state/reset ownership now lives in a Node-safe module, with the Electron adapter
re-exporting that same owner. Eight real process-restart cases and 96 scheduler/
IPC tests pass. A separate untouched rewind test failed once and passed on its
focused rerun; its cause is not established. The full desktop suite subsequently passed 1,447 tests with one existing skip
with the boundary correction.

The first broad desktop smoke run inherited a local Anthropic key; the test
correctly observed a connected provider instead of its intended empty fixture.
A subsequent run timed out before Electron created a window. The unchanged
lane passed serially with those credential variables absent only from the test
process. The delegated lane also intermittently timed out before its first
window; a diagnostic run of the same approval/reload case passed in 7.7 seconds
with a clean exit. The startup-timeout cause is not established. No assertion,
timeout, retry policy or supported feature was weakened.

No upstream issue or PR has been submitted. Expanded report drafts and related
report checks are in `docs/archive/agent-contract-history/mastra-boundary/upstream-1-71-drafts.md`.

## Why the integration became fragile

Durable tasks outlived request-scoped executor closures. Prompt history was used
as current-call identity. Child output had two delivery paths. Task terminal
status and wrapper EOF were mistaken for completion of actual effects and
storage cleanup. Finally, a parent conversation's durable decision lifetime was
assumed to match the lifetime of a native turn/idle stream.

The final ownership split removes those lifetime assumptions: native task
execution owns effects/output/cleanup, durable receipts own child identity and
reconstruction, and the existing host coordinator owns human decision admission
and subsequent parent turns. Public hook input replaces prompt-history guesses.
Task output has one delivery route, and Stop joins actual cleanup before success.

Exact-head review, required CI and merge status are tracked on PR #3337; local
reference proofs alone are not a claim that those delivery gates have passed.
