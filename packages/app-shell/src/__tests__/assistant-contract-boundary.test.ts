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
    expect(wrapperSource.split('\n').length).toBeLessThanOrEqual(1575);
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
    expect(wrapperTestSource.split('\n').length).toBeLessThanOrEqual(2075);
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
