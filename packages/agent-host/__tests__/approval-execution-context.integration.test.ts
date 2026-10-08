import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRunPythonExecutionContext } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
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

function tool(permissionToolId: string, inputSchema: HostTool['inputSchema']): HostTool {
  return {
    description: `${permissionToolId} fixture`,
    execute: async () => ({ ok: true }),
    identity: `${permissionToolId}-generation-1`,
    inputSchema,
    permissionToolId,
    risk: 'execute',
  };
}

async function requestFor(toolId: string, input: unknown): Promise<Requested> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-approval-context-'));
  const store = await StateStore.open(root);
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 2,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, execute: 'ask' },
      yolo: false,
    }),
    resolveModel: async () => scriptedToolSequence([{ input, toolId }]),
    tools: {
      execute_command: tool(
        NATIVE_TOOL_ID.executeCommand,
        z.object({ command: z.string() }).strict()
      ),
      run_python: tool(NATIVE_TOOL_ID.runPython, z.object({ code: z.string() }).strict()),
    },
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Run it.',
    threadId,
  });
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

test('a run_python approval carries the host-computed execution context its card shows', async () => {
  const input = { code: 'print("preview")' };
  const requested = await requestFor('run_python', input);
  expect(requested.executionContext).toEqual(resolveRunPythonExecutionContext(input));
  expect(requested.executionContext).toMatchObject({ allowedDomains: [], executorKind: 'fence' });
});

test('an approval of any other tool carries no execution context', async () => {
  const requested = await requestFor('execute_command', { command: 'echo preview' });
  expect(requested).not.toHaveProperty('executionContext');
});
