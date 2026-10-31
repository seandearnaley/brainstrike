/**
 * BST-2360: a command's approval says whether the command would run inside the
 * OS sandbox, committed beside the request, so the card can warn on a host
 * with none (Windows, the standalone host).
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

function commandTool(sandboxed: HostTool['sandboxed']): HostTool {
  return {
    description: 'command fixture',
    execute: async () => ({ ok: true }),
    identity: 'command-generation-1',
    inputSchema: z.object({ command: z.string() }).strict(),
    permissionToolId: 'brainstrike.executeCommand',
    risk: 'execute',
    ...(sandboxed ? { sandboxed } : {}),
  };
}

async function approvalRequest(tool: HostTool): Promise<Requested> {
  const root = await mkdtemp(join(tmpdir(), 'bs-command-sandbox-approval-'));
  const store = await StateStore.open(root);
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 2,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, execute: 'ask' },
      yolo: false,
    }),
    resolveModel: async () =>
      scriptedToolSequence([{ input: { command: 'echo hi' }, toolId: 'execute_command' }]),
    tools: { execute_command: tool },
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

test('a command on a host with no sandbox asks with sandboxed: false', async () => {
  const requested = await approvalRequest(commandTool(async () => false));
  expect(requested.sandboxed).toBe(false);
});

test('a command the sandbox will run asks with sandboxed: true', async () => {
  const requested = await approvalRequest(commandTool(async () => true));
  expect(requested.sandboxed).toBe(true);
});

test('a tool that runs no command asks without a sandbox fact', async () => {
  const requested = await approvalRequest(commandTool(undefined));
  expect(requested).not.toHaveProperty('sandboxed');
});
