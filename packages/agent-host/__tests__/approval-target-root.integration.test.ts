/**
 * BST-1990 (D4): an approval of a tool that targets a workspace folder carries
 * the folder its tool resolved for the call, committed beside the request, so
 * the card names it even when the call gave no `root`.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostTool } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

type Requested = Extract<HostEvent, { type: 'interaction.requested' }>;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

const writeTool: HostTool = {
  approvalTarget: (input) =>
    (input as { root?: string }).root === undefined
      ? { displayName: 'alpha-root', rootId: 'r-alpha' }
      : undefined,
  description: 'write fixture',
  execute: async () => ({ ok: true }),
  identity: 'write-generation-1',
  inputSchema: z.object({ content: z.string(), path: z.string(), root: z.string().optional() }),
  permissionToolId: 'brainstrike.writeWorkspaceFile',
  risk: 'edit',
};
const commandTool: HostTool = {
  description: 'command fixture',
  execute: async () => ({ ok: true }),
  identity: 'command-generation-1',
  inputSchema: z.object({ command: z.string() }).strict(),
  permissionToolId: 'brainstrike.executeCommand',
  risk: 'edit',
};

async function requestFor(toolId: string, input: unknown): Promise<Requested> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m6-approval-target-'));
  const store = await StateStore.open(root);
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 2,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask' },
      yolo: false,
    }),
    resolveModel: async () => scriptedToolSequence([{ input, toolId }]),
    tools: { execute_command: commandTool, write_file: writeTool },
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  await core.startRun({ commandId: randomUUID(), modelId: 'scripted', prompt: 'Go.', threadId });
  let requested: Requested | undefined;
  await expect
    .poll(async () => {
      requested = (await core.read(threadId, 0))
        .map((row) => row.event)
        .find((event): event is Requested => event.type === 'interaction.requested');
      return requested !== undefined;
    })
    .toBe(true);
  if (!requested) {
    throw new Error('Expected an approval request');
  }
  return requested;
}

test('a file approval carries the folder its tool resolved for the call', async () => {
  const requested = await requestFor('write_file', { content: 'x', path: 'notes.md' });
  expect(requested.targetRoot).toEqual({ displayName: 'alpha-root', rootId: 'r-alpha' });
});

test('an approval whose tool resolves no folder carries none', async () => {
  const unresolved = await requestFor('write_file', {
    content: 'x',
    path: 'notes.md',
    root: 'charlie',
  });
  expect(unresolved).not.toHaveProperty('targetRoot');
  const command = await requestFor('execute_command', { command: 'echo hi' });
  expect(command).not.toHaveProperty('targetRoot');
});
