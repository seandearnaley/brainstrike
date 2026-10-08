import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { BLOBS_DIR } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import {
  foldHostEditCheckpoints,
  HOST_EDIT_BASELINE_MAX_BYTES,
} from '../src/edit-checkpoint-view.js';
import type { HostPlatform, HostToolContext } from '../src/ports.js';
import type { HostEvent, HostLogRow } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { scriptedToolSequence } from '../src/test-fixtures/scripted-model.js';

const ROOT_ID = 'workspace-root';
const EditInput = z.discriminatedUnion('op', [
  z.strictObject({ content: z.string(), op: z.literal('write'), path: z.string() }),
  z.strictObject({ op: z.literal('delete'), path: z.string() }),
  z.strictObject({ fromPath: z.string(), op: z.literal('rename'), path: z.string() }),
]);
type Edit = z.infer<typeof EditInput>;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

type Recorded = Extract<HostEvent, { type: 'workspace.edit.recorded' }>;
function recorded(rows: readonly HostLogRow[]): Recorded[] {
  return rows.flatMap((row) => (row.event.type === 'workspace.edit.recorded' ? [row.event] : []));
}

interface Fixture {
  readonly dataRoot: string;
  /** The live root owner's current answer for ROOT_ID. */
  liveRoot: string;
  readonly models: Map<string, ReturnType<typeof scriptedToolSequence>>;
  readonly workspace: string;
}

async function fixture(): Promise<Fixture> {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'bs-edit-data-')));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'bs-edit-workspace-')));
  cleanup.push(async () => {
    await rm(dataRoot, { force: true, recursive: true });
    await rm(workspace, { force: true, recursive: true });
  });
  return { dataRoot, liveRoot: workspace, models: new Map(), workspace };
}

function platform(
  state: Fixture,
  extra: Partial<HostPlatform> = {},
  withRootOwner = true
): HostPlatform {
  const owned: HostPlatform = {
    close: async () => undefined,
    maxSteps: 12,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: true }),
    resolveModel: async (modelId) => {
      const model = state.models.get(modelId);
      if (!model) {
        throw new Error('Unscripted model');
      }
      return model;
    },
    resolveWorkspaceRoot: async ({ rootId }) => {
      if (rootId !== ROOT_ID) {
        throw new Error('Unknown workspace root');
      }
      return state.liveRoot;
    },
    tools: {
      edit: {
        description: 'Apply one fixture edit inside the workspace root',
        execute: async (input: unknown, context: HostToolContext) => {
          const edit = EditInput.parse(input);
          const edits = context.edits;
          if (!edits) {
            throw new Error('Core supplied no edit tracking capability');
          }
          const absolutePath = join(state.workspace, edit.path);
          if (edit.op === 'write') {
            await edits.track(
              { absolutePath, op: 'write', rootId: ROOT_ID, rootPath: state.workspace },
              async () => {
                await mkdir(join(absolutePath, '..'), { recursive: true });
                await writeFile(absolutePath, edit.content);
              }
            );
          } else if (edit.op === 'delete') {
            await edits.track(
              { absolutePath, op: 'delete', rootId: ROOT_ID, rootPath: state.workspace },
              () => unlink(absolutePath)
            );
          } else {
            const fromAbsolutePath = join(state.workspace, edit.fromPath);
            await edits.track(
              {
                absolutePath,
                fromAbsolutePath,
                op: 'rename',
                rootId: ROOT_ID,
                rootPath: state.workspace,
              },
              async () => {
                await mkdir(join(absolutePath, '..'), { recursive: true });
                await rename(fromAbsolutePath, absolutePath);
              }
            );
          }
          return { ok: true };
        },
        identity: 'workspace-edit-fixture-1',
        inputSchema: EditInput,
        risk: 'edit',
      },
    },
    ...extra,
  };
  if (!withRootOwner) {
    const { resolveWorkspaceRoot: _absent, ...rest } = owned;
    return rest;
  }
  return owned;
}

async function open(
  state: Fixture,
  extra?: Partial<HostPlatform>,
  withRootOwner = true
): Promise<{ client: HostClient; host: AgentHost }> {
  const host = await startAgentHost(
    { lifetime: 'persistent', root: state.dataRoot },
    platform(state, extra, withRootOwner)
  );
  const client = await attachAgentHost(host.record);
  const close = async () => {
    await client.close();
    await host.close();
  };
  cleanup.push(close);
  return { client, host };
}

async function rowsUntil(
  client: HostClient,
  threadId: string,
  done: (row: HostLogRow) => boolean
): Promise<readonly HostLogRow[]> {
  let rows: readonly HostLogRow[] = [];
  await expect
    .poll(async () => {
      rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      return rows.some(done);
    })
    .toBe(true);
  return rows;
}

/** One finished run whose model calls the fixture tool once per edit, in order. */
async function editRun(
  state: Fixture,
  client: HostClient,
  threadId: string,
  edits: readonly Edit[]
): Promise<{ readonly rows: readonly HostLogRow[]; readonly runId: string }> {
  const modelId = `scripted-${randomUUID()}`;
  state.models.set(
    modelId,
    scriptedToolSequence(edits.map((input) => ({ input, toolId: 'edit' })))
  );
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId,
    prompt: 'Edit the workspace',
    threadId,
  });
  const rows = await rowsUntil(
    client,
    threadId,
    (row) => row.event.type === 'run.finished' && row.event.runId === runId
  );
  const finished = rows.find(
    (row) => row.event.type === 'run.finished' && row.event.runId === runId
  )?.event;
  expect(finished).toMatchObject({ outcome: 'completed' });
  return { rows, runId };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('a run’s create, overwrite, delete and rename revert, after restart, to each path’s state before the run first changed it', async () => {
  const state = await fixture();
  const binary = Buffer.from([0, 255, 1, 254, 0x80, 0x81, 10]);
  await writeFile(join(state.workspace, 'keep.txt'), 'keep v0');
  await writeFile(join(state.workspace, 'doomed.bin'), binary);
  await chmod(join(state.workspace, 'doomed.bin'), 0o755);
  await writeFile(join(state.workspace, 'from.txt'), 'renamed source');
  let opened = await open(state);
  const { threadId } = await opened.client.request('thread/start', { commandId: randomUUID() });
  const { rows, runId } = await editRun(state, opened.client, threadId, [
    { content: 'created', op: 'write', path: 'new/dir/created.txt' },
    { content: 'keep v1', op: 'write', path: 'keep.txt' },
    { content: 'keep v2', op: 'write', path: 'keep.txt' },
    { op: 'delete', path: 'doomed.bin' },
    { fromPath: 'from.txt', op: 'rename', path: 'moved/to.txt' },
  ]);

  const edits = recorded(rows);
  const started = rows.flatMap((row) =>
    row.event.type === 'effect.started' ? [row.event.toolCallId] : []
  );
  expect(edits.map((edit) => [edit.op, edit.path, edit.fromPath, edit.toolCallId])).toEqual([
    ['write', 'new/dir/created.txt', undefined, started[0]],
    ['write', 'keep.txt', undefined, started[1]],
    ['write', 'keep.txt', undefined, started[2]],
    ['delete', 'doomed.bin', undefined, started[3]],
    ['rename', 'moved/to.txt', 'from.txt', started[4]],
  ]);
  // Only a run's first touch of a path captures its baseline.
  expect(edits.map((edit) => edit.baselines.map((baseline) => baseline.kind))).toEqual([
    ['absent'],
    ['content'],
    [],
    ['content'],
    ['content', 'absent'],
  ]);
  for (const edit of edits) {
    for (const baseline of edit.baselines) {
      if (baseline.kind === 'content') {
        expect(edit.blobRefs).toContain(baseline.blob);
        expect(await exists(join(state.dataRoot, BLOBS_DIR, baseline.blob))).toBe(true);
      }
    }
  }
  expect(await readFile(join(state.workspace, 'keep.txt'), 'utf8')).toBe('keep v2');
  expect(await exists(join(state.workspace, 'doomed.bin'))).toBe(false);

  // Restart: the fold of the committed log alone carries the baselines.
  await opened.client.close();
  await opened.host.close();
  cleanup.pop();
  opened = await open(state);

  const result = await opened.client.request('checkpoint/revert', {
    commandId: randomUUID(),
    runId,
    threadId,
  });
  expect(result.outcomes).toEqual(
    [...edits].reverse().map((edit) => ({ entryId: edit.entryId, status: 'reverted' }))
  );
  expect(await exists(join(state.workspace, 'new'))).toBe(false);
  expect(await readFile(join(state.workspace, 'keep.txt'), 'utf8')).toBe('keep v0');
  expect(await readFile(join(state.workspace, 'doomed.bin'))).toEqual(binary);
  expect((await stat(join(state.workspace, 'doomed.bin'))).mode & 0o777).toBe(0o755);
  expect(await readFile(join(state.workspace, 'from.txt'), 'utf8')).toBe('renamed source');
  expect(await exists(join(state.workspace, 'moved'))).toBe(false);

  const after = (await opened.client.request('thread/read', { fromSeq: 0, threadId })).rows;
  // The client fold presents the same edits in the existing checkpoint-undo DTO.
  const view = foldHostEditCheckpoints(after);
  expect(
    view.entries.map((entry) => [
      entry.op,
      entry.path,
      entry.fromPath,
      entry.captureStatus,
      entry.toolCallId,
      entry.revertedAt === null,
    ])
  ).toEqual([
    ['write', '/new/dir/created.txt', null, 'created', started[0], false],
    ['write', '/keep.txt', null, 'ok', started[1], false],
    ['write', '/keep.txt', null, 'ok', started[2], false],
    ['delete', '/doomed.bin', null, 'ok', started[3], false],
    ['rename', '/moved/to.txt', '/from.txt', 'rename', started[4], false],
  ]);
  expect([...view.availabilityById.values()]).toEqual(edits.map(() => ({ restorable: true })));
  expect(after.filter((row) => row.event.type === 'workspace.edit.reverted')).toEqual([
    expect.objectContaining({
      event: expect.objectContaining({ outcomes: result.outcomes, runId }),
    }),
  ]);
  // Nothing remains to revert in this run.
  expect(
    await opened.client.request('checkpoint/revert', {
      commandId: randomUUID(),
      runId,
      threadId,
    })
  ).toEqual({ outcomes: [] });
});

test('the conflict gate refuses a path changed after the run; force and a single-entry revert restore it', async () => {
  const state = await fixture();
  await writeFile(join(state.workspace, 'a.txt'), 'a v0');
  await writeFile(join(state.workspace, 'b.txt'), 'b v0');
  const { client } = await open(state);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { rows, runId } = await editRun(state, client, threadId, [
    { content: 'a v1', op: 'write', path: 'a.txt' },
    { content: 'b v1', op: 'write', path: 'b.txt' },
  ]);
  const [a, b] = recorded(rows);
  if (!(a && b)) {
    throw new Error('Both edits must be recorded');
  }
  await writeFile(join(state.workspace, 'a.txt'), 'a changed by the user');

  const command = { commandId: randomUUID(), runId, threadId };
  const first = await client.request('checkpoint/revert', command);
  expect(first.outcomes).toEqual([
    { entryId: b.entryId, status: 'reverted' },
    {
      entryId: a.entryId,
      reason: 'The file changed since this edit was recorded.',
      status: 'conflict',
    },
  ]);
  expect(await readFile(join(state.workspace, 'a.txt'), 'utf8')).toBe('a changed by the user');
  expect(await readFile(join(state.workspace, 'b.txt'), 'utf8')).toBe('b v0');
  // The same command ID returns its committed result without acting again.
  expect(await client.request('checkpoint/revert', command)).toEqual(first);

  expect(
    await client.request('checkpoint/revert', {
      commandId: randomUUID(),
      entryId: a.entryId,
      force: true,
      runId,
      threadId,
    })
  ).toEqual({ outcomes: [{ entryId: a.entryId, status: 'reverted' }] });
  expect(await readFile(join(state.workspace, 'a.txt'), 'utf8')).toBe('a v0');
  expect(
    await client.request('checkpoint/revert', {
      commandId: randomUUID(),
      entryId: b.entryId,
      runId,
      threadId,
    })
  ).toEqual({
    outcomes: [
      { entryId: b.entryId, reason: 'This edit was already reverted.', status: 'not_revertible' },
    ],
  });
  await expect(
    client.request('checkpoint/revert', {
      commandId: randomUUID(),
      entryId: 'not-an-entry',
      runId,
      threadId,
    })
  ).rejects.toThrow('Unknown edit checkpoint for this run');
});

test('an oversized prior file and a moved root refuse with their reasons, leaving disk untouched', async () => {
  const state = await fixture();
  const large = 'x'.repeat(HOST_EDIT_BASELINE_MAX_BYTES + 1);
  await writeFile(join(state.workspace, 'large.txt'), large);
  await writeFile(join(state.workspace, 'small.txt'), 'small v0');
  const { client } = await open(state);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { rows, runId } = await editRun(state, client, threadId, [
    { content: 'large v1', op: 'write', path: 'large.txt' },
    { content: 'small v1', op: 'write', path: 'small.txt' },
  ]);
  const [largeEdit, smallEdit] = recorded(rows);
  if (!(largeEdit && smallEdit)) {
    throw new Error('Both edits must be recorded');
  }
  expect(largeEdit.baselines).toEqual([
    { kind: 'unavailable', path: 'large.txt', reason: 'too_large' },
  ]);
  expect(largeEdit.blobRefs).toBeUndefined();
  const largeReason = `"large.txt": it was larger than ${HOST_EDIT_BASELINE_MAX_BYTES} bytes before this run changed it, so its prior content was not kept.`;
  // The client shows the refusal before any click, with the same copy the host refuses with.
  expect(foldHostEditCheckpoints(rows).availabilityById.get(largeEdit.entryId)).toEqual({
    reason: largeReason,
    restorable: false,
  });

  state.liveRoot = join(state.workspace, 'elsewhere');
  const moved = await client.request('checkpoint/revert', {
    commandId: randomUUID(),
    runId,
    threadId,
  });
  expect(moved.outcomes).toEqual([
    {
      entryId: smallEdit.entryId,
      reason:
        'Its workspace folder is no longer connected at the same location. Re-open the folder and try again.',
      status: 'not_revertible',
    },
    { entryId: largeEdit.entryId, reason: largeReason, status: 'not_revertible' },
  ]);
  expect(await readFile(join(state.workspace, 'small.txt'), 'utf8')).toBe('small v1');

  state.liveRoot = state.workspace;
  const restored = await client.request('checkpoint/revert', {
    commandId: randomUUID(),
    runId,
    threadId,
  });
  expect(restored.outcomes.map((outcome) => outcome.status)).toEqual([
    'reverted',
    'not_revertible',
  ]);
  expect(await readFile(join(state.workspace, 'small.txt'), 'utf8')).toBe('small v0');
  expect(await readFile(join(state.workspace, 'large.txt'), 'utf8')).toBe('large v1');
});

test('revert refuses without a live root owner, and for an unknown run', async () => {
  const state = await fixture();
  await writeFile(join(state.workspace, 'a.txt'), 'a v0');
  const { client } = await open(state, {}, false);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await editRun(state, client, threadId, [
    { content: 'a v1', op: 'write', path: 'a.txt' },
  ]);
  await expect(
    client.request('checkpoint/revert', { commandId: randomUUID(), runId, threadId })
  ).rejects.toThrow('Checkpoint revert requires the live workspace root owner');
  await expect(
    client.request('checkpoint/revert', { commandId: randomUUID(), runId: 'unknown', threadId })
  ).rejects.toThrow('Unknown run for this thread');
  expect(await readFile(join(state.workspace, 'a.txt'), 'utf8')).toBe('a v1');
});

test('revert is refused while any run of the thread is active, then allowed once it finishes', async () => {
  const state = await fixture();
  await writeFile(join(state.workspace, 'a.txt'), 'a v0');
  const { client } = await open(state, {
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
  });
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const modelId = `scripted-${randomUUID()}`;
  state.models.set(
    modelId,
    scriptedToolSequence([
      { input: { content: 'a v1', op: 'write', path: 'a.txt' }, toolId: 'edit' },
    ])
  );
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId,
    prompt: 'Edit the workspace',
    threadId,
  });
  const rows = await rowsUntil(
    client,
    threadId,
    (row) => row.event.type === 'interaction.requested'
  );
  const requested = rows.find((row) => row.event.type === 'interaction.requested')?.event;
  if (requested?.type !== 'interaction.requested') {
    throw new Error('The edit did not pause for approval');
  }
  await expect(
    client.request('checkpoint/revert', { commandId: randomUUID(), runId, threadId })
  ).rejects.toThrow('Checkpoint revert is refused while the thread has an active run');
  await client.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: requested.interactionId,
    runId,
    threadId,
  });
  await rowsUntil(
    client,
    threadId,
    (row) => row.event.type === 'run.finished' && row.event.runId === runId
  );
  expect(await readFile(join(state.workspace, 'a.txt'), 'utf8')).toBe('a v1');
  expect(
    (await client.request('checkpoint/revert', { commandId: randomUUID(), runId, threadId }))
      .outcomes
  ).toEqual([expect.objectContaining({ status: 'reverted' })]);
  expect(await readFile(join(state.workspace, 'a.txt'), 'utf8')).toBe('a v0');
});

test('thread deletion collects the baselines its edits referenced and purges platform caches', async () => {
  const state = await fixture();
  await writeFile(join(state.workspace, 'a.txt'), 'baseline only this thread keeps');
  const forgotten: string[] = [];
  let native: Awaited<ReturnType<typeof openIndexer>> | undefined;
  cleanup.push(async () => native?.close());
  const host = await startAgentHost(
    { lifetime: 'persistent', root: state.dataRoot },
    async (context) => {
      await context.register(async () => native?.close());
      native = await openIndexer(
        {
          dbPath: join(state.dataRoot, 'index.sqlite'),
          embedding: { indexMode: 'text-only' },
          rootIds: [state.dataRoot],
          stateProjection: {
            mode: 'dev',
            module: new URL('../dist/state-projection.js', import.meta.url).href,
          },
          stateRoot: state.dataRoot,
        },
        { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
      );
      return {
        ...platform(state),
        forgetThread: (threadId: string) => {
          forgotten.push(threadId);
        },
        stateIndexer: createStateStoreIndexer(native),
      };
    }
  );
  const client = await attachAgentHost(host.record);
  cleanup.push(async () => {
    await client.close();
    await host.close();
  });
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { rows } = await editRun(state, client, threadId, [
    { content: 'a v1', op: 'write', path: 'a.txt' },
  ]);
  const [edit] = recorded(rows);
  const baseline = edit?.baselines[0];
  if (baseline?.kind !== 'content') {
    throw new Error('The edit must capture a content baseline');
  }
  const blob = join(state.dataRoot, BLOBS_DIR, baseline.blob);
  expect(await readFile(blob, 'utf8')).toBe('baseline only this thread keeps');
  expect(await client.request('thread/delete', { threadId })).toEqual({ deleted: true });
  expect(await exists(blob)).toBe(false);
  // The platform purges the deleted thread's process-local tool caches.
  expect(forgotten).toEqual([threadId]);
});
