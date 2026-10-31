/**
 * BST-1932 S5: the desktop host's delegation capability, from the same
 * preferences and persona files the shipped assistant used (A26-A28).
 */
import {
  BUILT_IN_PERSONAS,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { resolveHostDelegation } from '@brainstrike/host-capabilities/delegation';
import { describe, expect, test } from 'vitest';

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

describe('resolveHostDelegation', () => {
  test('built-in and scanned user personas under the user’s settings', () => {
    const scanned: unknown[] = [];
    const delegation = resolveHostDelegation({ subagents }, roots, false, {
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

  test('a disabled persona is omitted; the master switch omits all (A26)', () => {
    const scan = () => ({ personas: [] });
    expect(
      resolveHostDelegation(
        { subagents: { ...subagents, disabledPersonaIds: ['explore'] } },
        roots,
        false,
        { scan }
      )?.personas.map((persona) => persona.id)
    ).toEqual(['analyze', 'worker']);
    expect(
      resolveHostDelegation(
        { subagents: { ...subagents, delegationEnabled: false } },
        roots,
        false,
        { scan }
      )
    ).toBeUndefined();
    expect(resolveHostDelegation({}, roots, false, { scan })).toBeUndefined();
  });

  test('plan mode omits every persona (A26)', () => {
    expect(
      resolveHostDelegation({ subagents }, roots, true, {
        scan: () => ({ personas: [reviewer] }),
      })
    ).toBeUndefined();
  });

  test('a persona file scan failure keeps the built-ins (A27)', () => {
    const delegation = resolveHostDelegation({ subagents }, roots, false, {
      scan: () => {
        throw new Error('unreadable agents directory');
      },
    });
    expect(delegation?.personas).toEqual(BUILT_IN_PERSONAS);
  });
});
