/**
 * Settings → Subagents panel: master delegation switch + per-persona toggles.
 * Desktop lists user personas (incl. invalid files with their error) from the
 * agent host's scan; without a host scan (web) only the built-ins render.
 */

import '@testing-library/jest-dom/vitest';
import { useSubagentPersonasStore } from '@brainstrike/app-state/stores/subagent-personas-store';
import {
  type AssistantPersonasListResult,
  BUILT_IN_PERSONAS,
} from '@brainstrike/assistant-contract';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubagentPersonasSettingsSection } from '../settings/system/subagent-personas-settings-section';

interface PersonasHost {
  list: () => Promise<AssistantPersonasListResult>;
}

let personasHost: PersonasHost | undefined;

function setHost(host: PersonasHost | undefined): void {
  personasHost = host;
}

/** The section as the desktop composes it: with the host's scan, when there is one. */
function Section() {
  return (
    <SubagentPersonasSettingsSection
      {...(personasHost ? { listPersonas: personasHost.list } : {})}
    />
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  setHost(undefined);
});

describe('SubagentPersonasSettingsSection', () => {
  it('renders built-in personas with switches defaulting to on', () => {
    render(<Section />);
    for (const persona of BUILT_IN_PERSONAS) {
      expect(screen.getByText(persona.label)).toBeInTheDocument();
      const toggle = screen.getByTestId(`subagent-persona-toggle-${persona.id}`);
      expect(toggle).toHaveAttribute('data-state', 'checked');
    }
  });

  it('master switch writes the store and disables the persona list', async () => {
    const user = userEvent.setup();
    render(<Section />);
    await user.click(screen.getByTestId('subagent-delegation-toggle'));
    expect(useSubagentPersonasStore.getState().delegationEnabled).toBe(false);
  });

  it('per-persona switch records the disabled id', async () => {
    const user = userEvent.setup();
    render(<Section />);
    await user.click(screen.getByTestId('subagent-persona-toggle-explore'));
    expect(useSubagentPersonasStore.getState().disabledPersonaIds).toEqual(['explore']);
  });

  it('lists user personas from the host, including invalid files with errors', async () => {
    setHost({
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
    render(<Section />);
    await waitFor(() => {
      expect(screen.getByText('Security Auditor')).toBeInTheDocument();
    });
    expect(screen.getByText(/anthropic::claude-haiku-4-5/u)).toBeInTheDocument();
    expect(screen.getByText(/persona frontmatter requires a description/u)).toBeInTheDocument();
    // Invalid personas get no availability toggle (there is nothing to enable).
    expect(screen.queryByTestId('subagent-persona-toggle-broken.md')).not.toBeInTheDocument();
  });

  it('renders two same-named invalid files from different roots as distinct rows', async () => {
    // Invalid entries key by absPath (their ids are just file names, which can
    // collide across roots — a React key collision would drop/mis-reconcile).
    setHost({
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
    render(<Section />);
    await waitFor(() => {
      expect(screen.getByText(/error A/u)).toBeInTheDocument();
    });
    expect(screen.getByText(/error B/u)).toBeInTheDocument();
    expect(screen.getAllByText('bad.md')).toHaveLength(2);
  });

  it('renders a shadowed file as an informational row, not an error', async () => {
    // BST-936: a suppressed duplicate must be VISIBLE, but it is a precedence
    // outcome — so no destructive styling, and no toggle (it is not loaded).
    setHost({
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
    render(<Section />);

    const detail = await screen.findByText(/Shadowed by/u);
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveClass('text-muted-foreground');
    expect(detail).not.toHaveClass('text-destructive');
    expect(screen.queryByTestId('subagent-persona-toggle-reviewer.md')).not.toBeInTheDocument();
  });

  it('warns about directories that were not fully scanned, in amber not red', async () => {
    // Neither cause is an authoring mistake, so red is reserved for "you must
    // fix a file"; and the notice sits OUTSIDE the delegation fieldset,
    // because it is about disk state (#2035 review).
    setHost({
      list: () =>
        Promise.resolve({
          incompleteDirs: [
            { dir: '/work/a/.brainstrike/agents', reason: 'listing-truncated' as const },
            { dir: '/home/user/.brainstrike/agents', reason: 'cap-reached' as const },
          ],
          personas: [],
        }),
    });
    render(<Section />);

    const warnings = await screen.findByTestId('subagent-personas-incomplete');
    expect(warnings).toHaveTextContent('/work/a/.brainstrike/agents');
    expect(warnings).toHaveTextContent(/not read/iu);
    expect(warnings).toHaveTextContent(/scan limit reached/iu);
    expect(warnings.querySelector('.text-destructive')).toBeNull();
    expect(warnings.closest('fieldset')).toBeNull();
  });
});

it('says a host issue blocks a persona without relying on colour', async () => {
  setHost({
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
  render(<Section />);
  const issue = await screen.findByText('Add credentials for anthropic in Providers.', {
    exact: false,
  });
  expect(issue).toHaveTextContent('Unavailable: Add credentials for anthropic in Providers.');
  expect(issue).toHaveClass('text-destructive');
});

it('reports loading failure and retries the host scan instead of hiding user profiles', async () => {
  let calls = 0;
  setHost({
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
  render(<Section />);
  expect(await screen.findByRole('alert')).toHaveTextContent('The personas didn’t load.');
  expect(screen.queryByText('private disk error')).not.toBeInTheDocument();
  expect(screen.queryByTestId('subagent-persona-toggle-worker')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Restored profile')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('keeps refresh disabled while the host scan is pending and enables it after settlement', async () => {
  const pending = Promise.withResolvers<AssistantPersonasListResult>();
  let calls = 0;
  setHost({
    list: () => {
      calls += 1;
      return pending.promise;
    },
  });
  render(<Section />);
  const refresh = screen.getByRole('button', { name: /^Refresh/u });
  expect(refresh).toBeDisabled();
  await userEvent.click(refresh);
  expect(calls).toBe(1);
  pending.resolve({ personas: [] });
  await waitFor(() => expect(refresh).toBeEnabled());
});
