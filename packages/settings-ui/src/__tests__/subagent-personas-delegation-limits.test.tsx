/**
 * Settings → Subagents: the delegation limits the panel states must be the
 * ENFORCED values — the user's settings, the same object every request
 * carries — never numbers typed into the panel. The store holds values no
 * default uses, so a panel that hardcodes numbers fails here (BST-1727).
 */

import '@testing-library/jest-dom/vitest';
import {
  __resetAssistantSubagentPreferencesStoreForTests,
  useAssistantSubagentPreferencesStore,
} from '@brainstrike/app-state/stores/assistant-subagent-preferences-store';
import { __resetSubagentPersonasStoreForTests } from '@brainstrike/app-state/stores/subagent-personas-store';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentPersonasSettingsSection } from '../settings/system/subagent-personas-settings-section';

vi.mock('@brainstrike/assistant-contract', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/assistant-contract')>();
  return {
    ...original,
    // The per-persona budget must come from the shared helper the host uses,
    // not from arithmetic repeated in the panel.
    effectiveChildStepBudget: () => 3,
  };
});

beforeEach(() => {
  window.localStorage.clear();
  __resetSubagentPersonasStoreForTests();
  __resetAssistantSubagentPreferencesStoreForTests();
  // Tree and per-child limits are USER SETTINGS; the panel must read them
  // from the preferences store, never from a constant.
  useAssistantSubagentPreferencesStore.setState({
    settings: {
      ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      maxChildOutputTokens: 4321,
      maxChildSteps: 7,
      maxConcurrentWork: 5,
      maxDepth: 7,
      maxInvocations: 11,
      maxTreeOutputTokens: 98_765,
    },
  });
});

afterEach(() => {
  cleanup();
  __resetAssistantSubagentPreferencesStoreForTests();
});

describe('SubagentPersonasSettingsSection delegation limits', () => {
  it('states the enforced tree-wide limits from the settings, in plain terms', () => {
    render(<SubagentPersonasSettingsSection />);
    const limits = screen.getByTestId('subagent-delegation-limits');
    expect(limits).toHaveTextContent('7 levels');
    expect(limits).toHaveTextContent('11 delegations per turn');
    expect(limits).toHaveTextContent('5 subagents working at once');
    expect(limits).toHaveTextContent(
      'No subagent may exceed 7 steps, whatever its persona declares (see Subagent limits below).'
    );
    expect(limits).toHaveTextContent('4,321');
    expect(limits).toHaveTextContent('98,765');
  });

  it('states each persona step budget through the shared helper the host enforces with', () => {
    render(<SubagentPersonasSettingsSection />);
    // Built-ins declare the 1000-step ceiling; the helper answers 3 while the
    // cap is 7. The panel must show that answer, not its own arithmetic.
    expect(screen.getAllByText(/Up to 3 steps/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Up to 1000 steps/)).not.toBeInTheDocument();
  });
});
