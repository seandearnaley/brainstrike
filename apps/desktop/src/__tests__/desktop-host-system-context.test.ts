/**
 * BST-1932: a delegating run's child context is the workspace context its root
 * sees (the date and the injected files), never the root's supervisor
 * instructions or the root's own context budget.
 */
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import {
  BUILT_IN_PERSONAS,
  encodeFileMentionId,
  serializeFileMentionDirective,
} from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import {
  type DesktopHostSystemContext,
  readDesktopHostSystemContext,
} from '../agent-host-platform/desktop-host-context';

const NOTES = 'NOTES_BODY_FOR_THE_TREE';
const mention = serializeFileMentionDirective({
  id: encodeFileMentionId('root-1', 'notes.md'),
  label: 'notes.md',
});

function read(
  personas: typeof BUILT_IN_PERSONAS | undefined,
  snapshot?: HostRunAdmissionRequest['snapshot']
): Promise<DesktopHostSystemContext> {
  return readDesktopHostSystemContext({
    inputTokenLimit: 5000,
    ...(personas ? { personas } : {}),
    planMode: false,
    readWorkspaceFile: async ({ requestedPath }) => ({
      content: NOTES,
      path: requestedPath,
      size: NOTES.length,
    }),
    request: {
      modelId: 'openrouter::model',
      prompt: `Summarize ${mention}`,
      signal: new AbortController().signal,
      threadId: 'thread-1',
      ...(snapshot ? { snapshot } : {}),
    },
    runtime: {
      model: 'model',
      provider: 'openrouter',
      workspaceRoots: [{ displayName: 'repo', path: '/work/repo', rootId: 'root-1' }],
    },
    tools: {},
  });
}

test('a delegating root names its personas; its children share only the workspace context', async () => {
  const { childSystem, system } = await read(BUILT_IN_PERSONAS);
  expect(system).toContain('(agent-explore)');
  expect(system).toContain('Context budget:');
  expect(system).toContain(NOTES);
  expect(childSystem).toContain('Today is ');
  expect(childSystem).toContain(NOTES);
  expect(childSystem).not.toContain('(agent-explore)');
  expect(childSystem).not.toContain('Context budget:');
});

test('a run that may not delegate has no child context', async () => {
  const context = await read(undefined);
  expect(context.system).toContain(NOTES);
  expect(context.system).not.toContain('(agent-explore)');
  expect(context).not.toHaveProperty('childSystem');
});

test('a recovered run and a wake reuse the committed root and child context', async () => {
  const context = await read(BUILT_IN_PERSONAS, {
    configuration: { childSystem: 'committed child', system: 'committed root' },
    maxSteps: 4,
    toolIdentities: {},
  });
  expect(context).toEqual({ childSystem: 'committed child', system: 'committed root' });
});
