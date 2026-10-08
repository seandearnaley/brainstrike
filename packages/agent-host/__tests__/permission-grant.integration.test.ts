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
  const store = await StateStore.open(root);
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
  const core = await HostCore.open(store, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  return { core, executed, threadId };
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
  'an approval with a $scope grant allows the rest of its run without asking again',
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

    // A grant answers its own run; a later run asks again.
    const later = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Write both fixtures again.',
      threadId,
    });
    expect(await nextRequest(core, threadId, later.runId, 0)).toMatchObject({ risk: 'edit' });
  }
);

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
