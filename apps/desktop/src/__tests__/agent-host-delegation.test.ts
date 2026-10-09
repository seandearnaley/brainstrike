/**
 * BST-1932 S5: the desktop host's delegation capability, from the same
 * preferences and persona files the shipped assistant used (A26-A28).
 */
import {
  BUILT_IN_PERSONAS,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { describe, expect, test } from 'vitest';
import { resolveDesktopHostDelegation } from '../agent-host-platform/desktop-host-delegation';

const reviewer: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.readWorkspaceFile'],
  description: 'Reviews code.',
  id: 'reviewer',
  instructions: 'Review.',
  label: 'Reviewer',
  maxSteps: 8,
  source: 'user',
};
const roots = [{ displayName: 'repo', path: '/work/repo', rootId: 'root-1' }];
const subagents = {
  delegationEnabled: true,
  disabledPersonaIds: [],
  settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxDepth: 2 },
};

describe('resolveDesktopHostDelegation', () => {
  test('built-in and scanned user personas under the user’s settings', () => {
    const scanned: unknown[] = [];
    const delegation = resolveDesktopHostDelegation({ subagents }, 'openrouter', roots, false, {
      scan: (input) => {
        scanned.push(input);
        return { personas: [reviewer] };
      },
    });
    expect(delegation?.personas.map((persona) => persona.id)).toEqual([
      ...BUILT_IN_PERSONAS.map((persona) => persona.id),
      'reviewer',
    ]);
    expect(delegation?.settings.maxDepth).toBe(2);
    expect(scanned).toEqual([
      { roots: [{ absPath: '/work/repo', displayName: 'repo', id: 'root-1' }] },
    ]);
  });

  test('a disabled persona is omitted; the master switch and the local provider omit all (A26)', () => {
    const scan = () => ({ personas: [] });
    expect(
      resolveDesktopHostDelegation(
        { subagents: { ...subagents, disabledPersonaIds: ['explore'] } },
        'openrouter',
        roots,
        false,
        { scan }
      )?.personas.map((persona) => persona.id)
    ).toEqual(['analyze', 'worker']);
    expect(
      resolveDesktopHostDelegation(
        { subagents: { ...subagents, delegationEnabled: false } },
        'openrouter',
        roots,
        false,
        { scan }
      )
    ).toBeUndefined();
    expect(
      resolveDesktopHostDelegation({ subagents }, 'local', roots, false, { scan })
    ).toBeUndefined();
    expect(resolveDesktopHostDelegation({}, 'openrouter', roots, false, { scan })).toBeUndefined();
  });

  test('plan mode omits every persona (A26)', () => {
    expect(
      resolveDesktopHostDelegation({ subagents }, 'openrouter', roots, true, {
        scan: () => ({ personas: [reviewer] }),
      })
    ).toBeUndefined();
  });

  test('a persona file scan failure keeps the built-ins (A27)', () => {
    const delegation = resolveDesktopHostDelegation({ subagents }, 'openrouter', roots, false, {
      scan: () => {
        throw new Error('unreadable agents directory');
      },
    });
    expect(delegation?.personas).toEqual(BUILT_IN_PERSONAS);
  });
});
