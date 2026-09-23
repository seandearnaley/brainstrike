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
  buildUserPersona,
  effectiveChildStepBudget,
  personaScope,
} from '@brainstrike/assistant-contract';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
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
            {
              // Worker mode with a declared read-only list: the mode permits
              // edit/run tools to be declared, it does not grant them.
              allowedToolIds: ['brainstrike.readWorkspaceFile'],
              description: 'Reads one file at a time.',
              id: 'one-shot',
              label: 'One shot',
              maxSteps: 1,
              mode: 'worker',
              source: 'user',
              status: 'ok',
            },
          ],
        }),
    });
    render(<SubagentPersonasSettingsSection />);
    const shipper = (await screen.findByTestId('subagent-persona-scope-shipper')).textContent;
    expect(shipper).toContain('Worker mode');
    expect(shipper).toContain('Up to 12 steps (1 reserved for its summary)');
    expect(shipper).toContain('every tool the host permits, including edit and run tools');
    const surveyor = screen.getByTestId('subagent-persona-scope-surveyor').textContent;
    expect(surveyor).toContain('Read-only');
    expect(surveyor).toContain('Up to 4 steps');
    expect(surveyor).toContain('3 tools');
    expect(surveyor).toContain('readWorkspaceFile');
    expect(surveyor).not.toContain('brainstrike.');
    // Worker mode never promises edit access the declared list does not give,
    // and a one-step child has no reserved summary turn.
    const oneShot = screen.getByTestId('subagent-persona-scope-one-shot').textContent;
    expect(oneShot).toContain('Worker mode');
    expect(oneShot).toContain('Up to 1 step ·');
    expect(oneShot).not.toContain('reserved');
    expect(oneShot).not.toContain('edit');
    expect(oneShot).toContain('1 tool: readWorkspaceFile');
  });

  it('shows a description-only profile as its curated read-only scope', async () => {
    const parsed = buildUserPersona({
      content: '---\ndescription: Surveys the workspace.\n---\nReturn the relevant facts.',
      fileName: 'minimal.md',
    });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const persona = parsed.persona;
    setBridge({
      list: () =>
        Promise.resolve({
          personas: [
            {
              ...personaScope(persona),
              description: persona.description,
              id: persona.id,
              label: persona.label,
              source: 'user',
              status: 'ok',
            },
          ],
        }),
    });
    render(<SubagentPersonasSettingsSection />);
    const scope = await screen.findByTestId('subagent-persona-scope-minimal');
    expect(scope).toHaveTextContent('Read-only');
    expect(scope).toHaveTextContent('7 tools:');
    expect(scope).toHaveTextContent('readWorkspaceFile');
    expect(scope).not.toHaveTextContent('every tool');
    expect(scope).not.toHaveTextContent('edit and run');
  });

  it('limits a read-only wildcard from a bridge to read-only host tools', async () => {
    // Current persona files reject read-only wildcards; the bridge contract
    // can still represent one, and its description must not widen its mode.
    setBridge({
      list: () =>
        Promise.resolve({
          personas: [
            {
              allowedToolIds: ['*'],
              description: 'Reads the host catalog.',
              id: 'reader',
              label: 'Reader',
              maxSteps: 4,
              mode: 'read-only',
              source: 'user',
              status: 'ok',
            },
          ],
        }),
    });
    render(<SubagentPersonasSettingsSection />);
    const scope = await screen.findByTestId('subagent-persona-scope-reader');
    expect(scope).toHaveTextContent('every read-only tool the host permits');
    expect(scope).not.toHaveTextContent('edit and run');
  });

  it("states the built-in personas' scope without the bridge from the same definitions the host enforces", () => {
    render(<SubagentPersonasSettingsSection />);
    const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
    const explore = BUILT_IN_PERSONAS.find((persona) => persona.id === 'explore');
    if (!(worker && explore)) {
      throw new Error('built-in worker and explore personas must exist');
    }
    const workerScope = screen.getByTestId('subagent-persona-scope-worker').textContent;
    expect(workerScope).toContain('Worker mode');
    // The shown budget is the enforced one: the user's setting governs.
    expect(workerScope).toContain(
      `Up to ${effectiveChildStepBudget(worker, DEFAULT_RUNTIME_SUBAGENT_SETTINGS)} steps`
    );
    expect(workerScope).toContain('every tool the host permits, including edit and run tools');
    const exploreScope = screen.getByTestId('subagent-persona-scope-explore').textContent;
    expect(exploreScope).toContain('Read-only');
    expect(exploreScope).toContain(`${explore.allowedToolIds.length} tools`);
  });

  it('without the bridge, shows the desktop-only note for user personas', () => {
    render(<SubagentPersonasSettingsSection />);
    expect(screen.getByText(/desktop/i)).toBeInTheDocument();
  });
});

it('shows an actionable host issue while keeping declared scope distinct', async () => {
  setBridge({
    list: async () => ({
      personas: [
        {
          allowedToolIds: ['missing.edit'],
          availability: {
            issues: [
              {
                code: 'credential-missing',
                message: 'Add credentials for anthropic in Providers.',
              },
            ],
            status: 'blocked',
          },
          description: 'Ships',
          id: 'shipper',
          label: 'Shipper',
          maxSteps: 7,
          mode: 'worker',
          source: 'user',
          status: 'ok',
        },
      ],
    }),
  });
  render(<SubagentPersonasSettingsSection />);
  expect(
    await screen.findByText('Add credentials for anthropic in Providers.')
  ).toBeInTheDocument();
  expect(screen.getByText('Unavailable until corrected')).toBeInTheDocument();
  expect(screen.getByText(/Declared scope:/)).toBeInTheDocument();
});

it('reports loading failure and retries the bridge instead of hiding user profiles', async () => {
  let calls = 0;
  setBridge({
    list: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('private disk error');
      }
      return {
        personas: [
          {
            description: 'Loaded',
            id: 'restored',
            label: 'Restored profile',
            source: 'user',
            status: 'ok',
          },
        ],
      };
    },
  });
  render(<SubagentPersonasSettingsSection />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load user personas');
  expect(screen.queryByText('private disk error')).not.toBeInTheDocument();
  expect(screen.queryByTestId('subagent-persona-toggle-worker')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Retry loading personas' }));
  expect(await screen.findByText('Restored profile')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('keeps refresh disabled while the host scan is pending and enables it after settlement', async () => {
  const pending = Promise.withResolvers<AssistantPersonasListResult>();
  let calls = 0;
  setBridge({
    list: () => {
      calls += 1;
      return pending.promise;
    },
  });
  render(<SubagentPersonasSettingsSection />);
  const refresh = screen.getByRole('button', { name: /personas/i });
  expect(refresh).toBeDisabled();
  await userEvent.click(refresh);
  expect(calls).toBe(1);
  pending.resolve({ personas: [] });
  await waitFor(() => expect(refresh).toBeEnabled());
});
