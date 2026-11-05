/**
 * ADR-0036: the desktop's approval card asks the host what a waiting file call
 * would change. Core answers from the call's own tool and commits nothing; the
 * answer carries file text, so only the desktop's private client may ask.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { HOST_VERSION } from '@brainstrike/host-lease';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { authenticateHostClient, type HostClient } from '../src/client-connection.js';
import { bindHostConnection } from '../src/connection.js';
import { HostCore } from '../src/core.js';
import type { HostClientOrigin, HostPlatform, HostTool } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';
import { AGENT_HOST_PROTOCOL_VERSION } from '../src/protocol-version.js';
import { scriptedToolSteps } from '../src/test-fixtures/scripted-model.js';
import { nodePortConnection } from '../src/transports.js';

type Requested = Extract<HostEvent, { type: 'interaction.requested' }>;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

/** The inputs the write tool was asked to preview. */
const previewed: unknown[] = [];
const writeTool: HostTool = {
  description: 'write fixture',
  execute: async () => ({ ok: true }),
  identity: 'write-generation-1',
  inputSchema: z.object({ content: z.string(), path: z.string() }).strict(),
  permissionToolId: 'brainstrike.writeWorkspaceFile',
  proposedChange: async (input) => {
    previewed.push(input);
    const { content, path } = input as { content: string; path: string };
    return { after: content, before: 'old\n', path };
  },
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

/** A run waiting on a write and a command, both asked in one step, and a client per origin. */
async function waitingRun() {
  previewed.length = 0;
  const root = await mkdtemp(join(tmpdir(), 'bs-interaction-preview-'));
  const store = await StateStore.open(root);
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 2,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask' },
      yolo: false,
    }),
    resolveModel: async () =>
      scriptedToolSteps([
        [
          { input: { content: 'new\n', path: 'notes.md' }, toolId: 'write_file' },
          { input: { command: 'echo hi' }, toolId: 'execute_command' },
        ],
      ]),
    tools: { execute_command: commandTool, write_file: writeTool },
  };
  const core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Go.',
    threadId,
  });
  const requested = async (): Promise<Requested[]> =>
    (await core.read(threadId, 0))
      .map((row) => row.event)
      .filter((event): event is Requested => event.type === 'interaction.requested');
  // The waiting step's own end, after both requests, is the last row the run commits while it waits.
  const stepEnded = async (): Promise<boolean> => {
    const events = (await core.read(threadId, 0)).map(({ event }) => event);
    const asked = events.findLastIndex((event) => event.type === 'interaction.requested');
    return events
      .slice(asked + 1)
      .some(
        (event) =>
          event.type === 'stream.chunk' &&
          typeof event.chunk === 'object' &&
          event.chunk !== null &&
          !Array.isArray(event.chunk) &&
          event.chunk['type'] === 'finish-step'
      );
  };
  await expect.poll(stepEnded).toBe(true);
  const events = await requested();
  expect(events).toHaveLength(2);
  const approval = (toolId: string): Requested => {
    const found = events.find((event) => event.toolId === toolId);
    if (!found) {
      throw new Error(`Expected the ${toolId} approval`);
    }
    return found;
  };
  return {
    command: approval('execute_command'),
    connect: (origin: HostClientOrigin) => connect(core, origin),
    rows: async () => (await core.read(threadId, 0)).length,
    run: { runId, threadId },
    write: approval('write_file'),
  };
}

async function connect(core: HostCore, origin: HostClientOrigin): Promise<HostClient> {
  const record = {
    hostVersion: HOST_VERSION,
    pid: process.pid,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: 'start',
  };
  const channel = new MessageChannel();
  const server = nodePortConnection(channel.port1);
  bindHostConnection(server, core, record, () => undefined, { origin });
  const closed = Promise.withResolvers<void>();
  const client = await authenticateHostClient(
    nodePortConnection(channel.port2),
    record,
    async () => {
      channel.port2.close();
      channel.port1.close();
      server.dispose();
      closed.resolve();
    },
    closed.promise
  );
  cleanup.push(() => client.close());
  return client;
}

test("the desktop sees the change a waiting call's own tool would make, and nothing is committed", async () => {
  const { connect: open, rows, run, write } = await waitingRun();
  const client = await open('desktop-ui');
  const before = await rows();
  await expect(
    client.request('interaction/preview', { ...run, interactionId: write.interactionId })
  ).resolves.toEqual({ after: 'new\n', before: 'old\n', path: 'notes.md' });
  expect(previewed).toEqual([{ content: 'new\n', path: 'notes.md' }]);
  expect(await rows()).toBe(before);
});

test('a call whose tool has no preview is refused as such', async () => {
  const { command, connect: open, run } = await waitingRun();
  const client = await open('desktop-ui');
  await expect(
    client.request('interaction/preview', { ...run, interactionId: command.interactionId })
  ).rejects.toMatchObject({ failure: { code: 'interaction.preview-unavailable' } });
});

test('an answered or unknown approval is stale', async () => {
  const { connect: open, run, write } = await waitingRun();
  const client = await open('desktop-ui');
  const stale = { failure: { code: 'interaction.stale', kind: 'refusal' } };
  await expect(
    client.request('interaction/preview', { ...run, interactionId: 'no-such-interaction' })
  ).rejects.toMatchObject(stale);
  await client.request('interaction/respond', {
    ...run,
    commandId: randomUUID(),
    decision: 'deny',
    interactionId: write.interactionId,
  });
  await expect(
    client.request('interaction/preview', { ...run, interactionId: write.interactionId })
  ).rejects.toMatchObject(stale);
  expect(previewed).toEqual([]);
});

test('only the desktop private client may read a preview', async () => {
  const { connect: open, run, write } = await waitingRun();
  const client = await open('public-socket');
  await expect(
    client.request('interaction/preview', { ...run, interactionId: write.interactionId })
  ).rejects.toMatchObject({
    failure: { category: 'authorization', code: 'interaction.preview-desktop-only' },
  });
  expect(previewed).toEqual([]);
});
