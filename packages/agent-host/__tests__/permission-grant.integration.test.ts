import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostEvent, HostLogRow, HostParams } from '../src/protocol.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

type Requested = Extract<HostEvent, { type: 'interaction.requested' }>;
type Grant = NonNullable<HostParams<'interaction/respond'>['grant']>;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

async function openHost() {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-permission-grant-'));
  const executed: unknown[] = [];
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 4,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask' },
      yolo: false,
    }),
    resolveModel: async () =>
      scriptedToolSequence([
        { input: { text: 'first' }, toolId: 'write_fixture' },
        { input: { text: 'second' }, toolId: 'write_fixture' },
      ]),
    tools: {
      write_fixture: {
        description: 'Write an owned fixture',
        execute: async (input) => {
          executed.push(input);
          return { written: true };
        },
        identity: 'write-fixture-generation-1',
        inputSchema: z.object({ text: z.string() }),
        permissionToolId: 'brainstrike.writeFixture',
        risk: 'edit',
      },
    },
  };
  let store = await StateStore.open(root);
  let core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const host = {
    core,
    executed,
    /** A new host process over the same committed state. */
    restart: async () => {
      await core.close();
      await store.close();
      store = await StateStore.open(root);
      core = await HostCore.open(store, platform, () => () => undefined);
      host.core = core;
    },
    threadId,
  };
  return host;
}

function writeBoth(core: HostCore, threadId: string): Promise<{ runId: string }> {
  return core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Write both fixtures.',
    threadId,
  });
}

async function nextRequest(
  core: HostCore,
  threadId: string,
  runId: string,
  index: number
): Promise<Requested> {
  let found: Requested | undefined;
  await expect
    .poll(async () => {
      found = (await core.read(threadId, 0))
        .map((row) => row.event)
        .filter(
          (event): event is Requested =>
            event.type === 'interaction.requested' && event.runId === runId
        )[index];
      return found !== undefined;
    })
    .toBe(true);
  if (!found) {
    throw new Error('Expected an approval request');
  }
  return found;
}

async function finished(core: HostCore, threadId: string, runId: string): Promise<HostLogRow[]> {
  await expect
    .poll(async () =>
      (await core.read(threadId, 0)).some(
        (row) => row.event.type === 'run.finished' && row.event.runId === runId
      )
    )
    .toBe(true);
  return (await core.read(threadId, 0)).filter(
    (row) => 'runId' in row.event && row.event.runId === runId
  );
}

test.each([
  { category: 'edit', scope: 'session' },
  { scope: 'tool', toolId: 'brainstrike.writeFixture' },
] satisfies Grant[])(
  'an approval with a $scope grant allows its thread’s later calls without asking again',
  async (grant) => {
    const { core, executed, threadId } = await openHost();
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Write both fixtures.',
      threadId,
    });
    const request = await nextRequest(core, threadId, runId, 0);
    // The host names the call's risk category, so a client can offer its grant.
    expect(request).toMatchObject({ kind: 'approval', risk: 'edit' });
    await core.respond({
      commandId: randomUUID(),
      decision: 'approve',
      grant,
      interactionId: request.interactionId,
      runId,
      threadId,
    });
    const rows = await finished(core, threadId, runId);
    expect(rows.find((row) => row.event.type === 'run.finished')?.event).toMatchObject({
      outcome: 'completed',
    });
    expect(rows.filter((row) => row.event.type === 'interaction.requested')).toHaveLength(1);
    expect(executed).toEqual([{ text: 'first' }, { text: 'second' }]);
    // The grant is committed with the decision, before the call resumes.
    const types = rows.map((row) => row.event.type);
    expect(types.indexOf('permission.granted')).toBe(types.indexOf('interaction.responded') - 1);
    expect(rows.find((row) => row.event.type === 'permission.granted')?.event).toEqual({
      grant,
      runId,
      type: 'permission.granted',
    });

    // The host keeps the thread's grant for its lifetime: a later run there does not ask.
    const later = await writeBoth(core, threadId);
    const laterRows = await finished(core, threadId, later.runId);
    expect(laterRows.filter((row) => row.event.type === 'interaction.requested')).toEqual([]);
    expect(executed).toHaveLength(4);
  }
);

test('a grant belongs to its thread and to this host process', async () => {
  const host = await openHost();
  const { runId } = await writeBoth(host.core, host.threadId);
  const request = await nextRequest(host.core, host.threadId, runId, 0);
  await host.core.respond({
    commandId: randomUUID(),
    decision: 'approve',
    grant: { category: 'edit', scope: 'session' },
    interactionId: request.interactionId,
    runId,
    threadId: host.threadId,
  });
  await finished(host.core, host.threadId, runId);

  // Another thread still asks.
  const other = await host.core.startThread({ commandId: randomUUID() });
  const otherRun = await writeBoth(host.core, other.threadId);
  expect(await nextRequest(host.core, other.threadId, otherRun.runId, 0)).toMatchObject({
    risk: 'edit',
  });

  // A restarted host replays the committed grant but does not restore it.
  await host.restart();
  const afterRestart = await writeBoth(host.core, host.threadId);
  expect(await nextRequest(host.core, host.threadId, afterRestart.runId, 0)).toMatchObject({
    risk: 'edit',
  });
});

test.each([
  { decision: 'approve', grant: { category: 'execute', scope: 'session' } },
  { decision: 'approve', grant: { scope: 'tool', toolId: 'brainstrike.otherTool' } },
  { decision: 'deny', grant: { category: 'edit', scope: 'session' } },
] satisfies { decision: 'approve' | 'deny'; grant: Grant }[])(
  'a grant that does not match its approved call is refused with nothing committed ($decision, $grant.scope)',
  async ({ decision, grant }) => {
    const { core, threadId } = await openHost();
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Write both fixtures.',
      threadId,
    });
    const request = await nextRequest(core, threadId, runId, 0);
    await expect(
      core.respond({
        commandId: randomUUID(),
        decision,
        grant,
        interactionId: request.interactionId,
        runId,
        threadId,
      })
    ).rejects.toThrow('Permission grant does not match the approved call');
    const committed = (await core.read(threadId, 0)).map((row) => row.event.type);
    expect(committed).not.toContain('permission.granted');
    expect(committed).not.toContain('interaction.responded');
  }
);
