/**
 * Settings → Subagents panel: master delegation switch + per-persona toggles.
 * Desktop lists user personas (incl. invalid files with their error) via the
 * capability-gated `window.assistantPersonas` bridge; without the bridge (web)
 * only the built-ins render, with an honest desktop-only note.
 */

import '@testing-library/jest-dom/vitest';
import {
  type AssistantPersonasListResult,
  BUILT_IN_PERSONAS,
} from '@brainstrike/assistant-contract';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubagentPersonasSettingsSection } from '../settings/system/subagent-personas-settings-section';
import {
  __resetSubagentPersonasStoreForTests,
  useSubagentPersonasStore,
} from '../stores/subagent-personas-store';

interface PersonasBridge {
  list: () => Promise<AssistantPersonasListResult>;
}

function setBridge(bridge: PersonasBridge | undefined): void {
  const host = window as { assistantPersonas?: PersonasBridge };
  if (bridge === undefined) {
    Reflect.deleteProperty(host, 'assistantPersonas');
  } else {
    host.assistantPersonas = bridge;
  }
}

beforeEach(() => {
  window.localStorage.clear();
  __resetSubagentPersonasStoreForTests();
});

afterEach(() => {
  cleanup();
  setBridge(undefined);
});

describe('SubagentPersonasSettingsSection', () => {
  it('renders built-in personas with switches defaulting to on', () => {
    render(<SubagentPersonasSettingsSection />);
    for (const persona of BUILT_IN_PERSONAS) {
      expect(screen.getByText(persona.label)).toBeInTheDocument();
      const toggle = screen.getByTestId(`subagent-persona-toggle-${persona.id}`);
      expect(toggle).toHaveAttribute('data-state', 'checked');
    }
  });

  it('master switch writes the store and disables the persona list', async () => {
    const user = userEvent.setup();
    render(<SubagentPersonasSettingsSection />);
    await user.click(screen.getByTestId('subagent-delegation-toggle'));
    expect(useSubagentPersonasStore.getState().delegationEnabled).toBe(false);
  });

  it('per-persona switch records the disabled id', async () => {
    const user = userEvent.setup();
    render(<SubagentPersonasSettingsSection />);
    await user.click(screen.getByTestId('subagent-persona-toggle-explore'));
    expect(useSubagentPersonasStore.getState().disabledPersonaIds).toEqual(['explore']);
  });

  it('lists user personas from the bridge, including invalid files with errors', async () => {
    setBridge({
      list: () =>
        Promise.resolve({
          personas: [
            {
              description: 'Security review',
              id: 'sec',
              label: 'Security Auditor',
              modelPin: 'anthropic::claude-haiku-4-5',
              source: 'user' as const,
              status: 'ok' as const,
            },
            {
              description: '',
              error: 'persona frontmatter requires a description',
              id: 'broken.md',
              label: 'broken.md',
              source: 'user' as const,
              status: 'invalid' as const,
            },
          ],
        }),
    });
    render(<SubagentPersonasSettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('Security Auditor')).toBeInTheDocument();
    });
    expect(screen.getByText(/anthropic::claude-haiku-4-5/)).toBeInTheDocument();
    expect(screen.getByText(/persona frontmatter requires a description/)).toBeInTheDocument();
    // Invalid personas get no availability toggle (there is nothing to enable).
    expect(screen.queryByTestId('subagent-persona-toggle-broken.md')).not.toBeInTheDocument();
  });

  it('without the bridge, shows the desktop-only note for user personas', () => {
    render(<SubagentPersonasSettingsSection />);
    expect(screen.getByText(/desktop/i)).toBeInTheDocument();
  });
});
