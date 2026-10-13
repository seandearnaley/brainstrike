/**
 * BST-1990 (D4): a run the host refuses before admitting it reaches the client
 * with the "not admitted" JSON-RPC code and the host's own refusal text, so the
 * client may hand the user's message back for a resend. Nothing was committed.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import { HOST_RUN_NOT_ADMITTED_CODE } from '../src/protocol.js';
import { startAgentHost } from '../src/runtime.js';

const REFUSAL = 'The selected workspace root is no longer mounted';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

test('a run refused before admission carries the not-admitted code and the refusal text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m6-not-admitted-'));
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 2,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveModel: async () => {
      throw new Error(REFUSAL);
    },
    tools: {},
  };
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  const client = await attachAgentHost(host.record);
  cleanup.push(async () => {
    await client.close();
    await host.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });

  const refusal: unknown = await client
    .request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Hello',
      threadId,
    })
    .then(
      () => undefined,
      (cause: unknown) => cause
    );

  expect(refusal).toMatchObject({ code: HOST_RUN_NOT_ADMITTED_CODE, message: REFUSAL });
  const rows = await client.request('thread/read', { fromSeq: 0, threadId });
  expect(rows.rows.some((row) => row.event.type === 'run.started')).toBe(false);
});
