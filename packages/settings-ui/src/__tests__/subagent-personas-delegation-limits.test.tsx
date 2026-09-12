/**
 * Settings → Subagents: the tree-wide delegation limits the panel states must
 * be the ENFORCED values, read from `DELEGATION_LIMITS`, never numbers typed
 * into the panel. This file mocks the constant with values no real build uses,
 * so a panel that hardcodes the real numbers fails here (BST-1727).
 */

import '@testing-library/jest-dom/vitest';
import { __resetSubagentPersonasStoreForTests } from '@brainstrike/app-state/stores/subagent-personas-store';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentPersonasSettingsSection } from '../settings/system/subagent-personas-settings-section';

vi.mock('@brainstrike/assistant-contract', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/assistant-contract')>();
  return {
    ...original,
    DELEGATION_LIMITS: Object.freeze({
      ...original.DELEGATION_LIMITS,
      maxChildOutputTokens: 4321,
      maxChildSteps: 7,
      maxConcurrentWork: 5,
      maxDepth: 9,
      maxInvocations: 11,
      maxTreeOutputTokens: 98_765,
    }),
    // The per-persona budget must come from the shared helper the host uses,
    // not from arithmetic repeated in the panel.
    effectiveChildStepBudget: () => 7,
  };
});

beforeEach(() => {
  window.localStorage.clear();
  __resetSubagentPersonasStoreForTests();
});

afterEach(() => {
  cleanup();
});

describe('SubagentPersonasSettingsSection delegation limits', () => {
  it('states the enforced tree-wide limits from DELEGATION_LIMITS, in plain terms', () => {
    render(<SubagentPersonasSettingsSection />);
    const limits = screen.getByTestId('subagent-delegation-limits');
    expect(limits).toHaveTextContent('9 levels');
    expect(limits).toHaveTextContent('11 delegations per turn');
    expect(limits).toHaveTextContent('5 subagents working at once');
    expect(limits).toHaveTextContent('7 steps');
    expect(limits).toHaveTextContent('4,321');
    expect(limits).toHaveTextContent('98,765');
  });

  it('states each persona step budget through the shared helper the host enforces with', () => {
    render(<SubagentPersonasSettingsSection />);
    // Built-in personas declare 16 steps; the mocked helper answers 7, and the
    // panel must show that answer, not its own arithmetic.
    expect(screen.getAllByText(/Up to 7 steps/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Up to 16 steps/)).not.toBeInTheDocument();
  });
});
