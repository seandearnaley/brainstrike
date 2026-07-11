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
    expect(wrapperSource.split('\n').length).toBeLessThanOrEqual(1520);
  });

  it('keeps the assistant panel wrapper executable test under the test-file budget', () => {
    const wrapperTestSource = readSource('__tests__/assistant-ui-panel-wrapper.test.tsx');

    // Bumped 2000 → 2025 for the run-completion checkpoint refetch wiring test:
    // it fires the panel's onRunFinished seam and asserts the checkpoint journal
    // is re-read without a thread switch (the turn-level "Revert all edits"
    // footer's headline scenario — see PR #1568 / EDIT CHECKPOINT JOURNAL).
    expect(wrapperTestSource.split('\n').length).toBeLessThanOrEqual(2025);
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
