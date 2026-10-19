/**
 * BST-1178: a person answers the first call to each browser origin. Allow once
 * runs that call; Always allow and Don't allow are saved in the host's
 * StateStore and answer every later call to the origin, across a restart.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { readHostBrowserOrigins } from '../src/browser-origin-answers.js';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostTool } from '../src/ports.js';
import type { HostEvent, HostLogRow } from '../src/protocol.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

type Requested = Extract<HostEvent, { type: 'interaction.requested' }>;
type Posture = ReturnType<HostPlatform['readPermissionPolicy']>;

const ALLOWING: Posture = { policies: DEFAULT_PERMISSION_POLICIES, yolo: false };
const EXAMPLE = 'https://example.com';
const OTHER = 'https://other.example';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

function navigateTool(opened: string[]): HostTool {
  return {
    browserOrigin: (input) => {
      const { url } = input as { url: string };
      return url.startsWith('http') ? new URL(url).origin : undefined;
    },
    description: 'navigate fixture',
    execute: async (input) => {
      opened.push((input as { url: string }).url);
      return { ok: true };
    },
    identity: 'browser-navigate-generation-1',
    inputSchema: z.object({ url: z.string() }).strict(),
    permissionToolId: NATIVE_TOOL_ID.browserNavigate,
    risk: 'read',
  };
}

async function openHost(posture: Posture, urls: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), 'bs-bst-1178-origin-consent-'));
  const opened: string[] = [];
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: urls.length + 1,
    readPermissionPolicy: () => posture,
    resolveModel: async () =>
      scriptedToolSequence(urls.map((url) => ({ input: { url }, toolId: 'navigate' }))),
    tools: { navigate: navigateTool(opened) },
  };
  let store = await StateStore.open(root);
  let core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  return {
    get core(): HostCore {
      return core;
    },
    opened,
    async reopen(): Promise<void> {
      await core.close();
      await store.close();
      store = await StateStore.open(root);
      core = await HostCore.open(store, platform, () => () => undefined);
    },
    get store(): StateStore {
      return store;
    },
  };
}

async function events(core: HostCore, threadId: string): Promise<HostEvent[]> {
  return (await core.read(threadId, 0)).map((row: HostLogRow) => row.event);
}

async function requested(core: HostCore, threadId: string, count: number): Promise<Requested> {
  let found: Requested[] = [];
  await expect
    .poll(async () => {
      found = (await events(core, threadId)).filter(
        (event): event is Requested => event.type === 'interaction.requested'
      );
      return found.length;
    })
    .toBe(count);
  const last = found.at(-1);
  if (!last) {
    throw new Error('Expected an interaction request');
  }
  return last;
}

async function finished(core: HostCore, threadId: string): Promise<HostEvent[]> {
  await expect
    .poll(async () => (await events(core, threadId)).find((event) => event.type === 'run.finished'))
    .toMatchObject({ outcome: 'completed' });
  return await events(core, threadId);
}

async function start(core: HostCore) {
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Open the pages.',
    threadId,
  });
  return { runId, threadId };
}

test('allow once opens that call only: the next call to the same origin asks again', async () => {
  const host = await openHost(ALLOWING, [`${EXAMPLE}/a`, `${EXAMPLE}/b`]);
  const { runId, threadId } = await start(host.core);

  const first = await requested(host.core, threadId, 1);
  expect(first).toMatchObject({
    kind: 'network',
    origin: EXAMPLE,
    toolCatalogId: NATIVE_TOOL_ID.browserNavigate,
  });
  // The read policy allows, so the card stands in for no approval and offers no grant.
  expect(first).not.toHaveProperty('risk');
  await host.core.resume({
    commandId: randomUUID(),
    interactionId: first.interactionId,
    resumeData: { action: 'allow' },
    runId,
    threadId,
  });

  const second = await requested(host.core, threadId, 2);
  expect(second).toMatchObject({ kind: 'network', origin: EXAMPLE });
  await expect(readHostBrowserOrigins(host.store)).resolves.toEqual({});
  await host.core.resume({
    commandId: randomUUID(),
    interactionId: second.interactionId,
    resumeData: { action: 'allow', remember: true },
    runId,
    threadId,
  });

  await finished(host.core, threadId);
  expect(host.opened).toEqual([`${EXAMPLE}/a`, `${EXAMPLE}/b`]);
  await expect(readHostBrowserOrigins(host.store)).resolves.toEqual({ [EXAMPLE]: 'allow' });
  // The committed log the desktop's origin card replays
  // (apps/desktop/src/__tests__/fixtures/committed-host-origin.json).
  const recordTo = process.env['BRAINSTRIKE_RECORD_ORIGIN_CONSENT'];
  if (recordTo) {
    await writeFile(
      join(recordTo, 'committed-host-origin.json'),
      JSON.stringify(await host.core.read(threadId, 0), null, 2)
    );
  }
});

test('always allow is saved: later calls to the origin run unasked, across a restart', async () => {
  const host = await openHost(ALLOWING, [`${EXAMPLE}/a`, `${EXAMPLE}/b`, `${OTHER}/`]);
  const { runId, threadId } = await start(host.core);

  const first = await requested(host.core, threadId, 1);
  await host.core.resume({
    commandId: randomUUID(),
    interactionId: first.interactionId,
    resumeData: { action: 'allow', remember: true },
    runId,
    threadId,
  });
  // The second call to the saved origin runs unasked; the other origin asks.
  const other = await requested(host.core, threadId, 2);
  expect(other).toMatchObject({ origin: OTHER });
  expect(host.opened).toEqual([`${EXAMPLE}/a`, `${EXAMPLE}/b`]);
  await expect(readHostBrowserOrigins(host.store)).resolves.toEqual({ [EXAMPLE]: 'allow' });

  await host.reopen();
  await expect(readHostBrowserOrigins(host.store)).resolves.toEqual({ [EXAMPLE]: 'allow' });
  await host.core.resume({
    commandId: randomUUID(),
    interactionId: other.interactionId,
    resumeData: { action: 'allow' },
    runId,
    threadId,
  });
  await finished(host.core, threadId);
  expect(host.opened).toEqual([`${EXAMPLE}/a`, `${EXAMPLE}/b`, `${OTHER}/`]);
});

test("don't allow is saved and final: the call never runs, and the model reads why", async () => {
  const host = await openHost(ALLOWING, [`${EXAMPLE}/a`, `${EXAMPLE}/b`]);
  const { runId, threadId } = await start(host.core);

  const first = await requested(host.core, threadId, 1);
  await host.core.resume({
    commandId: randomUUID(),
    interactionId: first.interactionId,
    resumeData: { action: 'deny', remember: true },
    runId,
    threadId,
  });

  const log = await finished(host.core, threadId);
  // The second call was refused by the saved answer, without another card.
  expect(log.filter((event) => event.type === 'interaction.requested')).toHaveLength(1);
  expect(log.some((event) => event.type === 'effect.started')).toBe(false);
  expect(host.opened).toEqual([]);
  await expect(readHostBrowserOrigins(host.store)).resolves.toEqual({ [EXAMPLE]: 'deny' });
  const reason = `The user doesn't allow opening ${EXAMPLE}.`;
  const denials = JSON.stringify(log).split(reason).length - 1;
  // Each call's denial reaches the model with its reason: the answered one and the saved one.
  expect(denials).toBeGreaterThanOrEqual(2);
});

test('under an asking read policy the origin card also approves the call, and may carry a grant', async () => {
  const host = await openHost(
    { policies: { ...DEFAULT_PERMISSION_POLICIES, read: 'ask' }, yolo: false },
    [`${EXAMPLE}/a`]
  );
  const { runId, threadId } = await start(host.core);

  const first = await requested(host.core, threadId, 1);
  expect(first).toMatchObject({ kind: 'network', origin: EXAMPLE, risk: 'read' });
  await host.core.resume({
    commandId: randomUUID(),
    grant: { category: 'read', scope: 'session' },
    interactionId: first.interactionId,
    resumeData: { action: 'allow', remember: true },
    runId,
    threadId,
  });
  const log = await finished(host.core, threadId);
  expect(log.filter((event) => event.type === 'permission.granted')).toHaveLength(1);
  expect(host.opened).toEqual([`${EXAMPLE}/a`]);
});

test('a call that names no origin it could open is left to its tool, unasked', async () => {
  const host = await openHost(ALLOWING, ['about:blank']);
  const { threadId } = await start(host.core);
  const log = await finished(host.core, threadId);
  expect(log.some((event) => event.type === 'interaction.requested')).toBe(false);
  expect(host.opened).toEqual(['about:blank']);
});

test('only a browser origin consent may be remembered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-bst-1178-network-remember-'));
  const store = await StateStore.open(root);
  const tool: HostTool = {
    consent: () => true,
    description: 'network fixture',
    execute: async () => ({ ok: true }),
    identity: 'network-generation-1',
    inputSchema: z.object({ domain: z.string() }).strict(),
    risk: 'execute',
  };
  const core = await HostCore.open(
    store,
    {
      close: async () => undefined,
      maxSteps: 2,
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, execute: 'allow' },
        yolo: false,
      }),
      resolveModel: async () =>
        scriptedToolSequence([{ input: { domain: 'pypi.org' }, toolId: 'fetch' }]),
      tools: { fetch: tool },
    },
    () => () => undefined
  );
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { runId, threadId } = await start(core);
  const consent = await requested(core, threadId, 1);
  expect(consent).not.toHaveProperty('origin');
  await expect(
    core.resume({
      commandId: randomUUID(),
      interactionId: consent.interactionId,
      resumeData: { action: 'allow', remember: true },
      runId,
      threadId,
    })
  ).rejects.toThrow("Only a browser origin's consent is remembered");
  await expect(readHostBrowserOrigins(store)).resolves.toEqual({});
});
