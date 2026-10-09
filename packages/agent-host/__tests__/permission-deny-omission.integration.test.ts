import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostTool } from '../src/ports.js';
import type { HostEvent } from '../src/protocol.js';

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

function tool(risk: HostTool['risk'], permissionToolId: string): HostTool {
  return {
    description: `A ${risk} fixture`,
    execute: async () => ({ ok: true }),
    identity: `${permissionToolId}-generation-1`,
    inputSchema: z.object({}),
    permissionToolId,
    risk,
  };
}

/** The model only answers; it records the tools each request offered. */
function recordingModel(offered: string[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      offered.push((options.tools ?? []).map((offeredTool) => offeredTool.name));
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { id: 'text-1', type: 'text-start' },
            { delta: 'Done.', id: 'text-1', type: 'text-delta' },
            { id: 'text-1', type: 'text-end' },
            { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
          ],
          initialDelayInMs: null,
        }),
      };
    },
  });
}

test('a tool the saved policy denies is neither offered to the model nor admitted to the run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-permission-deny-'));
  const store = await StateStore.open(root);
  const offered: string[][] = [];
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 2,
    // Edits are denied by category; one read tool is denied by its override.
    readPermissionPolicy: () => ({
      perToolOverrides: { 'brainstrike.readSecret': 'deny' },
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'deny' },
      yolo: true,
    }),
    resolveModel: async () => recordingModel(offered),
    tools: {
      read_file: tool('read', 'brainstrike.readFile'),
      read_secret: tool('read', 'brainstrike.readSecret'),
      write_file: tool('edit', 'brainstrike.writeFile'),
    },
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
    prompt: 'Look around.',
    threadId,
  });
  await expect
    .poll(async () =>
      (await core.read(threadId, 0)).some(
        (row) => row.event.type === 'run.finished' && row.event.runId === runId
      )
    )
    .toBe(true);
  // An explicit deny outranks YOLO: the denied tools are never offered.
  expect(offered).toEqual([['read_file']]);
  const started = (await core.read(threadId, 0)).find((row) => row.event.type === 'run.started')
    ?.event as Extract<HostEvent, { type: 'run.started' }>;
  expect(Object.keys(started.snapshot?.toolIdentities ?? {})).toEqual(['read_file']);
});
