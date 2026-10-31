/**
 * A run cut off while its tool runs says why it ended: closing the host records
 * "Host is closing", and the user's own Stop records no reason (BST-2394).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import { crashableStorePort, stream, toolCall } from './fixtures/child-run-host.js';

test('a run cut off mid-tool records why: host close names it, a user Stop does not', async () => {
  const toolEntered = new Map<string, PromiseWithResolvers<void>>();
  const entered = (prompt: string) => {
    const known = toolEntered.get(prompt) ?? Promise.withResolvers<void>();
    toolEntered.set(prompt, known);
    return known;
  };
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const asked = prompt.findLast((message) => message.role === 'user');
      const text = Array.isArray(asked?.content)
        ? asked.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
        : '';
      return stream(toolCall('probe', { text }, `call-${randomUUID()}`));
    },
  });
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {
      probe: {
        description: 'Read-only probe that runs until its run ends',
        execute: ({ text }: { text: string }, { signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            entered(text).resolve();
          }),
        identity: 'probe-identity',
        inputSchema: z.object({ text: z.string() }),
        risk: 'read',
      },
    },
  };
  const dir = await mkdtemp(join(tmpdir(), 'bs-host-close-detail-'));
  const store = await StateStore.open(dir);
  const core = await HostCore.open(crashableStorePort(store).port, platform, () => () => undefined);
  onTestFinished(async () => {
    await core.close();
    await store.close();
    await rm(dir, { force: true, recursive: true });
  });
  const start = async (prompt: string) => {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt,
      threadId,
    });
    await entered(prompt).promise;
    return { runId, threadId };
  };
  // Read from the store itself: the closed Core serves no reads.
  const ended = async ({ runId, threadId }: { runId: string; threadId: string }) =>
    (await store.read(threadId, 0)).find(
      ({ event }) => event.type === 'run.finished' && event['runId'] === runId
    )?.event;

  const stopped = await start('Call the probe, then stop.');
  await core.stop({ commandId: randomUUID(), ...stopped });
  await expect.poll(() => ended(stopped)).toBeDefined();

  const closed = await start('Call the probe, then quit.');
  await core.close();

  const stoppedEnd = await ended(stopped);
  expect(stoppedEnd).toMatchObject({ outcome: 'stopped' });
  expect(stoppedEnd).not.toHaveProperty('detail');
  expect(await ended(closed)).toMatchObject({ detail: 'Host is closing', outcome: 'interrupted' });
});
