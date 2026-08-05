import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_SHELL_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_SHELL_PACKAGE_ROOT = path.resolve(APP_SHELL_SRC_ROOT, '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(APP_SHELL_SRC_ROOT, relativePath), 'utf8');
}

function readPackageFile(relativePath: string): string {
  return readFileSync(path.join(APP_SHELL_PACKAGE_ROOT, relativePath), 'utf8');
}

describe('app-shell assistant contract boundary', () => {
  it('reads assistant run events from assistant-contract instead of agent runtime', () => {
    expect(readSource('assistant-memory-repository.ts')).not.toMatch(
      /@brainstrike\/agent\/run-events/
    );
  });

  it('keeps thread draft runtime data structurally typed inside app-shell', () => {
    expect(readSource('assistant-thread-store.ts')).not.toMatch(/@brainstrike\/agent['"]/);
  });

  it('reads provider and tool metadata from assistant-contract instead of agent runtime packages', () => {
    const wrapperSource = readSource('assistant-ui-panel-wrapper.tsx');

    expect(wrapperSource).not.toMatch(/@brainstrike\/agent\/provider-metadata/);
    expect(wrapperSource).not.toMatch(/@brainstrike\/agent\/tool-metadata/);
  });

  it('reads local-runtime metadata from assistant-contract instead of agent runtime packages', () => {
    expect(readSource('assistant-ui-panel-wrapper.tsx')).not.toMatch(
      /@brainstrike\/agent\/(?:client|local-runtime)/
    );
    expect(readSource('__tests__/assistant-ui-panel-wrapper.test.tsx')).not.toMatch(
      /@brainstrike\/agent\/(?:client|local-runtime)/
    );
  });

  it('reads runtime request metadata from assistant-contract instead of the agent root package', () => {
    expect(readSource('assistant-ui-panel-wrapper.tsx')).not.toMatch(/from '@brainstrike\/agent'/);
  });

  it('keeps the assistant panel wrapper as a composition module under the source-file budget', () => {
    const wrapperSource = readSource('assistant-ui-panel-wrapper.tsx');

    // Bumped 1500 → 1520 to acknowledge the workspace-instructions context
    // wiring (#1566) that grew the wrapper to 1518 lines, plus the
    // user-slash-commands thread-scoped `useAssistantSlashCommands` wiring.
    // Bumped 1525 → 1540 for per-model vision attachment gating: the shared
    // selected-model definition memo (feeds both the token budget and the
    // composer attachment gate) plus the attachments-availability memo.
    // Bumped 1540 → 1550 for the Task Ledger run-verdict binding: the wrapper
    // only calls useRunVerdictBinding and mounts <RunVerdictProvider>; the
    // phase machine and runId detection live in packages/ui
    // (run-verdict-control.tsx / run-verdict-context.tsx).
    // Bumped 1550 → 1565 for the budget guardrail binding: the wrapper only
    // calls useBudgetGuardrailBinding and mounts <BudgetGuardrailProvider>; the
    // spend derivation lives in cost-tracking/use-daily-spend.ts and the
    // chip/gate UI in packages/ui (budget-guardrail-control.tsx).
    // Bumped 1565 → 1575 for the context-breakdown stale-clear review fix:
    // handleUsage calls hasContextBreakdownChannel (assistant-ui-panel-wrapper-runtime.ts)
    // and clears a thread's stale breakdown via
    // useContextUsageStore.getState().clearBreakdown when the active turn's
    // transport structurally cannot refresh it (capability-absent local runtime).
    // Bumped 1575 → 1620 after the three concurrently-merged wrapper-touching
    // PRs landed together: the universal-grant wiring (#1736,
    // grantAllToolsForSession), the context-breakdown stale-clear (#1738,
    // handleUsage → clearBreakdown), and multi-root main-vs-focused clarity
    // (#1735: the wrapper derives mainRootId/mainRootPath and the ≥2-roots
    // operatingRoot chip payload; the chip UI lives in operating-root-chip.tsx).
    // The merged wrapper measures 1614 lines; budget carries modest headroom.
    // Bumped 1620 → 1625 for Anthropic cache-token usage persistence (BST-587):
    // the wrapper only spreads pickCacheTokenFields(usage) into recordRunUsage;
    // the payload type and field picker live in assistant-ui-panel-wrapper-runtime.ts.
    // Bumped 1625 → 1635 for mid-run steering (BST-588): the wrapper only calls
    // useSteerActiveRun (transport in use-steer-active-run.ts) and passes
    // onSteerActiveRun to the panel behind the desktop-bridge capability gate.
    // BST-593 adds the provider-read-error prop and threads it into the existing
    // disabled-reason composition boundary without adding runtime ownership.
    // BST-697 adds only the OpenRouter defaults hook call; policy and mutation
    // remain isolated in the hook and model-registry store action.
    // Bumped 1645 → 1660 for the "Copy debug bundle" binding (Task 9, Flight
    // Recorder capstone): the wrapper only calls useDebugBundleBinding and
    // mounts <DebugBundleProvider>; the runId detection, phase machine, and
    // collect/format logic all live in packages/ui
    // (copy-debug-bundle-button.tsx / debug-bundle-context.tsx) and
    // diagnostics/debug-bundle.ts.
    // Bumped 1660 → 1705 for the BST-940 auto-observer resolution memo: the
    // wrapper only calls resolveEffectiveObservationalMemorySettings (policy in
    // wrapper-runtime.ts + the contract's resolveAutoObservationalMemoryModelTarget),
    // passes omAwaitingObserver into the existing OM meter composition, and —
    // per the review privacy/eligibility rulings — feeds it the selected chat
    // provider plus a model-catalog eligibility predicate over the registry
    // store subscriptions it already holds.
    // Bumped 1705 → 1740 for the BST-953 thread-total taps: the wrapper only
    // adds two wiring callbacks — handleChildRunUsage (validates with the
    // contract's isAssistantChildRunUsage, then re-reads the cumulative view)
    // and handleStepUsage (records into the ui store's live sum) — plus the
    // live-sum clear ordering in handleUsage. Aggregation policy lives in
    // assistant-cumulative-usage.ts, capture in packages/agent, persistence in
    // the desktop server, and display in packages/ui.
    // Bumped 1740 → 1790 after rebasing onto main's thread auto-naming
    // (#2060): the union of that wrapper wiring and the BST-953 review fixes
    // (live-sum terminal clears + zero-baseline hydration) measures 1780.
    // Bumped 1790 → 1800 for the BST-1113 changeset lifecycle refresh: the
    // wrapper only calls useChangeset (hook + policy in
    // packages/app-shell/src/changes/use-changeset.ts) and composes its
    // `refresh` into the existing handleRunFinished/handleRunFailed callbacks
    // beside refetchCheckpoints — no changeset SELECTION UI lands until W4, so
    // the changeset argument is hardcoded null and the call is inert today.
    // Bumped 1800 → 1810 for BST-1115 W5 T4b (rewind finalization): the
    // wrapper adds ONE hook call and ONE prop. The two-signal trigger, the
    // arming flag, the `prepareRequestData` composition and all failure
    // surfacing live in changes/use-rewind-finalization.ts — the wrapper only
    // supplies the seam and the thread id, and forwards `onThreadRunStart`.
    // NOT bumped for the BST-1115 re-hydration counter: the wrapper reads one
    // number from `changes/rewind-store.ts` and forwards it as one prop, which
    // is what a composition module is allowed to grow by. The counter's
    // rationale, the panel's `key` mechanics and the Changes-surface
    // invalidation all live outside this file.
    expect(wrapperSource.split('\n').length).toBeLessThanOrEqual(1810);
  });

  it('keeps the assistant panel wrapper executable test under the test-file budget', () => {
    const wrapperTestSource = readSource('__tests__/assistant-ui-panel-wrapper.test.tsx');

    // Bumped 2000 → 2025 for the run-completion checkpoint refetch wiring test:
    // it fires the panel's onRunFinished seam and asserts the checkpoint journal
    // is re-read without a thread switch (the turn-level "Revert all edits"
    // footer's headline scenario — see PR #1568 / EDIT CHECKPOINT JOURNAL).
    // Bumped 2025 → 2075 for the composer attachment gating tests: the
    // transport-hidden case plus the vision-unsupported disabled-with-reason /
    // vision-supported enabled transitions under the data-stream transport.
    // Bumped 2075 → 2100 for the BST-1113 changeset lifecycle refresh
    // composition test (mocked `useChangeset`, proving both
    // handleRunFinished/handleRunFailed call `refresh` and that every call is
    // wired with a null changeset until W4 lands a selection).
    expect(wrapperTestSource.split('\n').length).toBeLessThanOrEqual(2100);
  });

  it('reads built-in local LLM availability from assistant-contract instead of agent runtime packages', () => {
    expect(readSource('hooks/use-assistant-availability-with-local.ts')).not.toMatch(
      /@brainstrike\/agent\/local-llm/
    );
    expect(readSource('__tests__/use-assistant-availability-with-local.test.ts')).not.toMatch(
      /@brainstrike\/agent\/local-llm/
    );
  });

  it('has no direct app-shell dependency on the agent runtime package', () => {
    const packageJson = JSON.parse(readPackageFile('package.json')) as {
      dependencies?: Record<string, string>;
    };

    expect(readSource('assistant-memory-repository.ts')).not.toMatch(/@brainstrike\/agent/);
    expect(readSource('assistant-ui-panel-wrapper.tsx')).not.toMatch(/@brainstrike\/agent/);
    expect(readSource('__tests__/assistant-ui-panel-wrapper.test.tsx')).not.toMatch(
      /@brainstrike\/agent/
    );
    expect(packageJson.dependencies).not.toHaveProperty('@brainstrike/agent');
  });
});
