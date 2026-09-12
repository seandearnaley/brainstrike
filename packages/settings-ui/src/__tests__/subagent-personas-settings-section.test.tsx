/**
 * Settings → Subagents panel: master delegation switch + per-persona toggles.
 * Desktop lists user personas (incl. invalid files with their error) via the
 * capability-gated `window.assistantPersonas` bridge; without the bridge (web)
 * only the built-ins render, with an honest desktop-only note.
 */

import '@testing-library/jest-dom/vitest';
import {
  __resetSubagentPersonasStoreForTests,
  useSubagentPersonasStore,
} from '@brainstrike/app-state/stores/subagent-personas-store';
import {
  type AssistantPersonasListResult,
  BUILT_IN_PERSONAS,
} from '@brainstrike/assistant-contract';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubagentPersonasSettingsSection } from '../settings/system/subagent-personas-settings-section';

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

  it('renders two same-named invalid files from different roots as distinct rows', async () => {
    // Invalid entries key by absPath (their ids are just file names, which can
    // collide across roots — a React key collision would drop/mis-reconcile).
    setBridge({
      list: () =>
        Promise.resolve({
          personas: [
            {
              absPath: '/work/a/.brainstrike/agents/bad.md',
              description: '',
              error: 'error A',
              id: 'bad.md',
              label: 'bad.md',
              source: 'user' as const,
              status: 'invalid' as const,
            },
            {
              absPath: '/work/b/.brainstrike/agents/bad.md',
              description: '',
              error: 'error B',
              id: 'bad.md',
              label: 'bad.md',
              source: 'user' as const,
              status: 'invalid' as const,
            },
          ],
        }),
    });
    render(<SubagentPersonasSettingsSection />);
    await waitFor(() => {
      expect(screen.getByText(/error A/)).toBeInTheDocument();
    });
    expect(screen.getByText(/error B/)).toBeInTheDocument();
    expect(screen.getAllByText('bad.md')).toHaveLength(2);
  });

  it('renders a shadowed file as an informational row, not an error', async () => {
    // BST-936: a suppressed duplicate must be VISIBLE, but it is a precedence
    // outcome — so no destructive styling, and no toggle (it is not loaded).
    setBridge({
      list: () =>
        Promise.resolve({
          personas: [
            {
              absPath: '/home/user/.brainstrike/agents/reviewer.md',
              description: '',
              id: 'reviewer.md',
              label: 'reviewer.md',
              shadowedBy: { absPath: '/work/a/.brainstrike/agents/reviewer.md' },
              source: 'user' as const,
              status: 'shadowed' as const,
            },
          ],
        }),
    });
    render(<SubagentPersonasSettingsSection />);

    const detail = await screen.findByText(/this copy is inactive/i);
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveClass('text-muted-foreground');
    expect(detail).not.toHaveClass('text-destructive');
    expect(screen.queryByTestId('subagent-persona-toggle-reviewer.md')).not.toBeInTheDocument();
  });

  it('warns about directories that were not fully scanned, in amber not red', async () => {
    // Neither cause is an authoring mistake, so red is reserved for "you must
    // fix a file"; and the notice sits OUTSIDE the delegation fieldset,
    // because it is about disk state (#2035 review).
    setBridge({
      list: () =>
        Promise.resolve({
          incompleteDirs: [
            { dir: '/work/a/.brainstrike/agents', reason: 'listing-truncated' as const },
            { dir: '/home/user/.brainstrike/agents', reason: 'cap-reached' as const },
          ],
          personas: [],
        }),
    });
    render(<SubagentPersonasSettingsSection />);

    const warnings = await screen.findByTestId('subagent-personas-incomplete');
    expect(warnings).toHaveTextContent('/work/a/.brainstrike/agents');
    expect(warnings).toHaveTextContent(/not read/i);
    expect(warnings).toHaveTextContent(/scan limit reached/i);
    expect(warnings.querySelector('.text-destructive')).toBeNull();
    expect(warnings.closest('fieldset')).toBeNull();
  });

  it("states each persona's mode, step budget and tool scope from the bridge, in plain terms", async () => {
    setBridge({
      list: () =>
        Promise.resolve({
          personas: [
            {
              allowedToolIds: ['*'],
              description: 'Ships the deliverable.',
              id: 'shipper',
              label: 'Shipper',
              maxSteps: 12,
              mode: 'worker',
              source: 'user',
              status: 'ok',
            },
            {
              allowedToolIds: [
                'brainstrike.readWorkspaceFile',
                'brainstrike.grepSearch',
                'brainstrike.globWorkspace',
              ],
              description: 'Surveys the tree.',
              id: 'surveyor',
              label: 'Surveyor',
              maxSteps: 4,
              mode: 'read-only',
              source: 'user',
              status: 'ok',
            },
          ],
        }),
    });
    render(<SubagentPersonasSettingsSection />);
    const shipper = (await screen.findByTestId('subagent-persona-scope-shipper')).textContent;
    expect(shipper).toContain('Can edit and run');
    expect(shipper).toContain('Up to 12 steps');
    expect(shipper).toContain('every tool the host permits');
    const surveyor = screen.getByTestId('subagent-persona-scope-surveyor').textContent;
    expect(surveyor).toContain('Read-only');
    expect(surveyor).toContain('Up to 4 steps');
    expect(surveyor).toContain('3 tools');
    expect(surveyor).toContain('readWorkspaceFile');
  });

  it("states the built-in personas' scope without the bridge from the same definitions the host enforces", () => {
    render(<SubagentPersonasSettingsSection />);
    const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
    const explore = BUILT_IN_PERSONAS.find((persona) => persona.id === 'explore');
    if (!(worker && explore)) {
      throw new Error('built-in worker and explore personas must exist');
    }
    const workerScope = screen.getByTestId('subagent-persona-scope-worker').textContent;
    expect(workerScope).toContain('Can edit and run');
    expect(workerScope).toContain(`Up to ${worker.maxSteps} steps`);
    expect(workerScope).toContain('every tool the host permits');
    const exploreScope = screen.getByTestId('subagent-persona-scope-explore').textContent;
    expect(exploreScope).toContain('Read-only');
    expect(exploreScope).toContain(`${explore.allowedToolIds.length} tools`);
  });

  it('without the bridge, shows the desktop-only note for user personas', () => {
    render(<SubagentPersonasSettingsSection />);
    expect(screen.getByText(/desktop/i)).toBeInTheDocument();
  });
});
