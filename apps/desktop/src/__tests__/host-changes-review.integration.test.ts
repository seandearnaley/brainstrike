// @vitest-environment node
/**
 * A host thread's Changes review, resolved by Main from the host's committed
 * log (BST-1977). A real agent host runs a scripted model whose tool edits a
 * file through Core's edit tracking, while an untracked write stands in for a
 * shell side effect. The run's admission snapshots its root with the real
 * shadow-git owner at the turn's start and end, and Main's changeset resolver
 * reads the turn and the tool edits through the host client:
 * - while the run is live (paused on approval), its start against the live
 *   work-tree, without attribution;
 * - once it has ended, start against end, with the committed tool edit
 *   attributed and the side effect not;
 * - once the host owns the thread, no ledger or database read;
 * - a failed capture, or a run that ended without its turn end, fails visibly;
 * - a thread the host does not own refuses without a retired ledger lookup.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachAgentHost,
  type HostClient,
  type HostLogRow,
  HostLogRowSchema,
  type HostRunAdmission,
  type HostToolContext,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { Schema } from 'effect';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createHostThreadTurns } from '../assistant-server/changeset-host-turns';
import { createSnapshotChangesetResolver } from '../assistant-server/changeset-snapshot-view';
import { FAILED_SNAPSHOT_CAPTURE_OID } from '../assistant-server/snapshot-repository';
import { createSnapshotService, type SnapshotService } from '../assistant-server/snapshot-service';
import { captureRootSnapshot } from '../assistant-server/snapshot-turn-boundaries';
import { fixtureSnapshotGitRunner } from './assistant-server/_git-fixture-environment';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});
const ORIGINAL = 'turn-start content\n';
const ROOT_ID = 'fixture-root';
const TOOL_IDENTITY = 'native-fixture-generation-1';
async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  return directory;
}
/** Main's capture over the shared shadow-git owner, as `platform/snapshot/capture` serves it. */
function captureWith(
  service: SnapshotService,
  workspace: string,
  options: HostRunOptions
): NonNullable<HostRunAdmission['captureTurnBoundary']> {
  return async (request) => {
    if (request.boundary === 'turn-start') {
      await options.startGate;
      if (options.failStart) {
        throw new Error('the shadow repository is unavailable');
      }
    }
    const roots =
      request.boundary === 'turn-start'
        ? [{ path: workspace, rootId: ROOT_ID }]
        : (request.roots ?? []).map(({ rootId, rootPath }) => ({ path: rootPath, rootId }));
    const snapshots = [];
    for (const root of roots) {
      const outcome = await captureRootSnapshot(
        service,
        request.boundary,
        request.threadId,
        request.runId,
        root
      );
      snapshots.push({
        commitOid: outcome.kind === 'captured' ? outcome.commitOid : FAILED_SNAPSHOT_CAPTURE_OID,
        rootId: root.rootId,
        rootPath: outcome.rootPath,
      });
    }
    return snapshots;
  };
}
const forbiddenPg = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Changes must not acquire PG');
  })
);
vi.mock('@brainstrike/db/pglite-factory', async (original) => ({
  ...(await original<typeof import('@brainstrike/db/pglite-factory')>()),
  createBrainstrikePglite: forbiddenPg,
}));
function mainResolver(
  service: SnapshotService,
  source: Parameters<typeof createHostThreadTurns>[0]
) {
  const resolver = createSnapshotChangesetResolver({
    hostThreads: createHostThreadTurns(source),
    resolveService: () => service,
  });
  return { resolver };
}
function clientSource(client: HostClient): Parameters<typeof createHostThreadTurns>[0] {
  return {
    listThreads: async () =>
      new Set((await client.request('thread/list', {})).threads.map(({ threadId }) => threadId)),
    readRows: async (threadId, fromSeq) =>
      (await client.request('thread/read', { fromSeq, threadId })).rows,
  };
}
async function rowsUntil(
  client: HostClient,
  threadId: string,
  done: (row: HostLogRow) => boolean
): Promise<readonly HostLogRow[]> {
  const session = new CommittedThreadSession(client, threadId);
  const ready = Promise.withResolvers<readonly HostLogRow[]>();
  const release = session.subscribe(() => {
    const snapshot = session.getSnapshot();
    if (snapshot.error) {
      ready.reject(new Error(snapshot.error));
    } else if (!snapshot.connected) {
      ready.reject(new Error('Host disconnected before the required committed event'));
    } else if (snapshot.rows.some(done)) {
      ready.resolve(snapshot.rows);
    }
  });
  const disconnect = session.connect();
  const close = async (): Promise<void> => {
    release();
    ready.reject(new Error('Test cleanup ended the pending host row wait'));
    await disconnect();
  };
  cleanup.push(close);
  try {
    const rows = await ready.promise;
    expect(rows.some(done)).toBe(true);
    return rows;
  } finally {
    await close();
  }
}
interface HostRunOptions {
  readonly failStart?: boolean;
  /** Holds the run's turn-start capture until it settles. */
  readonly startGate?: Promise<void>;
}
/** A host thread whose first run has started; its turn may still be capturing. */
async function startedHostRun(options: HostRunOptions = {}) {
  const hostRoot = await temporaryDirectory('bs-m3-host-changes-host-');
  const workspace = await temporaryDirectory('bs-m3-host-changes-workspace-');
  const shadow = await temporaryDirectory('bs-m3-host-changes-shadow-');
  const file = join(workspace, 'permitted.txt');
  await writeFile(file, ORIGINAL);
  const service = createSnapshotService({
    runner: fixtureSnapshotGitRunner,
    snapshotsBaseDir: shadow,
  });
  const model = scriptedModel('write_file');
  const host = await startAgentHost(
    { lifetime: 'persistent', root: hostRoot },
    {
      admitRun: async () => ({
        captureTurnBoundary: captureWith(service, workspace, options),
        configuration: {},
        model,
        snapshot: { configuration: {}, maxSteps: 3, toolIdentities: { write_file: TOOL_IDENTITY } },
        tools: {
          write_file: {
            description: 'Write an owned fixture file',
            execute: async (input: unknown, context: HostToolContext) => {
              const { text } = z.object({ text: z.string() }).parse(input);
              if (!context.edits) {
                throw new Error('Core supplied no edit tracking capability');
              }
              await context.edits.track(
                { absolutePath: file, op: 'write', rootId: ROOT_ID, rootPath: workspace },
                () => writeFile(file, `${text}\n`)
              );
              return { path: file };
            },
            identity: TOOL_IDENTITY,
            inputSchema: z.object({ text: z.string() }),
            risk: 'edit',
          },
        },
      }),
      close: async () => undefined,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    }
  );
  cleanup.push(() => host.close());
  const client = await attachAgentHost(host.record);
  cleanup.push(() => client.close());
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Edit the permitted file',
    threadId,
  });
  return { client, runId, service, threadId, workspace };
}
/** A host thread whose first run is paused on the default `edit:ask` approval of a tracked write. */
async function pausedHostRun(options: HostRunOptions = {}) {
  const started = await startedHostRun(options);
  const rows = await rowsUntil(
    started.client,
    started.threadId,
    (row) => row.event.type === 'interaction.requested'
  );
  const requested = rows.find((row) => row.event.type === 'interaction.requested')?.event;
  if (requested?.type !== 'interaction.requested') {
    throw new Error('The tracked write did not pause for approval');
  }
  return { ...started, requested };
}
test('a host run is reviewed live against the work-tree, then start against end with its tool edit attributed', async () => {
  const paused = await pausedHostRun();
  const { resolver } = mainResolver(paused.service, clientSource(paused.client));
  const changeset = { kind: 'agent-run' as const, runId: paused.runId, threadId: paused.threadId };
  // A side effect no tool tracked, while the run waits on approval.
  await writeFile(join(paused.workspace, 'shell-made.txt'), 'made by a shell\n');
  const live = await resolver.resolveView(changeset);
  expect(live).toEqual({
    ok: true,
    value: {
      changeset,
      files: [
        expect.objectContaining({ path: 'shell-made.txt', rootId: ROOT_ID, status: 'added' }),
      ],
      totalAdditions: 1,
      totalDeletions: 0,
    },
  });
  expect(live.ok && live.value.files[0]).not.toHaveProperty('toolAttributed');
  expect(forbiddenPg).not.toHaveBeenCalled();
  await paused.client.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: paused.requested.interactionId,
    runId: paused.runId,
    threadId: paused.threadId,
  });
  const rows = await rowsUntil(
    paused.client,
    paused.threadId,
    (row) => row.event.type === 'run.finished' && row.event.runId === paused.runId
  );
  expect(
    rows.filter((row) => row.event.type === 'workspace.snapshot.recorded').map((row) => row.event)
  ).toEqual([
    expect.objectContaining({ boundary: 'turn-start', runId: paused.runId }),
    expect.objectContaining({ boundary: 'turn-end', runId: paused.runId }),
  ]);
  const settled = await resolver.resolveView(changeset);
  expect(settled).toEqual({
    ok: true,
    value: {
      changeset,
      files: expect.arrayContaining([
        expect.objectContaining({
          path: 'permitted.txt',
          status: 'modified',
          toolAttributed: true,
        }),
        expect.objectContaining({ path: 'shell-made.txt', status: 'added', toolAttributed: false }),
      ]),
      totalAdditions: 2,
      totalDeletions: 1,
    },
  });
  expect(settled.ok && settled.value.files).toHaveLength(2);
  const diff = await resolver.fileDiff(ROOT_ID, changeset, 'permitted.txt');
  expect(diff).toMatchObject({ ok: true, value: { path: 'permitted.txt', status: 'modified' } });
  // Once the host owns the thread, its turns are read from the host's log alone.
  expect(forbiddenPg).not.toHaveBeenCalled();
});
test('a rewind preview’s host run range is each root’s restore point against the live work-tree', async () => {
  const paused = await pausedHostRun();
  await paused.client.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: paused.requested.interactionId,
    runId: paused.runId,
    threadId: paused.threadId,
  });
  await rowsUntil(
    paused.client,
    paused.threadId,
    (row) => row.event.type === 'run.finished' && row.event.runId === paused.runId
  );
  // A change after the turn ended: a rewind restores it too, so its view shows it.
  await writeFile(join(paused.workspace, 'after-the-turn.txt'), 'written later\n');
  const { resolver } = mainResolver(paused.service, clientSource(paused.client));
  const changeset = {
    fromRunId: paused.runId,
    kind: 'run-range' as const,
    threadId: paused.threadId,
  };
  const view = await resolver.resolveView(changeset);
  expect(view).toEqual({
    ok: true,
    value: {
      changeset,
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'permitted.txt', rootId: ROOT_ID, status: 'modified' }),
        expect.objectContaining({ path: 'after-the-turn.txt', rootId: ROOT_ID, status: 'added' }),
      ]),
      totalAdditions: 2,
      totalDeletions: 1,
    },
  });
  expect(view.ok && view.value.files).toHaveLength(2);
  const diff = await resolver.fileDiff(ROOT_ID, changeset, 'permitted.txt');
  expect(diff).toMatchObject({ ok: true, value: { path: 'permitted.txt', status: 'modified' } });
  expect(forbiddenPg).not.toHaveBeenCalled();
  // A host range ending at a TO run is refused visibly, never approximated.
  const bounded = await resolver.resolveView({ ...changeset, toRunId: paused.runId });
  expect(!bounded.ok && bounded.error).toMatch(/^run-range-unsupported: /);
  expect(forbiddenPg).not.toHaveBeenCalled();
});
test('a run resolved before its turn start is committed resolves once it is', async () => {
  const gate = Promise.withResolvers<void>();
  const started = await startedHostRun({ startGate: gate.promise });
  const { resolver } = mainResolver(started.service, clientSource(started.client));
  const changeset = {
    kind: 'agent-run' as const,
    runId: started.runId,
    threadId: started.threadId,
  };
  await rowsUntil(started.client, started.threadId, (row) => row.event.type === 'run.started');
  // "Last Turn" follows a run the moment it starts, before its turn-start capture lands.
  const early = await resolver.resolveView(changeset);
  expect(!early.ok && early.error).toMatch(
    /^changeset-snapshot-missing: .*recorded no workspace snapshots/
  );
  gate.resolve();
  await rowsUntil(
    started.client,
    started.threadId,
    (row) => row.event.type === 'workspace.snapshot.recorded'
  );
  await writeFile(join(started.workspace, 'shell-made.txt'), 'made by a shell\n');
  expect(forbiddenPg).not.toHaveBeenCalled();
  const live = await resolver.resolveView(changeset);
  expect(live).toMatchObject({
    ok: true,
    value: { files: [expect.objectContaining({ path: 'shell-made.txt', status: 'added' })] },
  });
  expect(forbiddenPg).not.toHaveBeenCalled();
});
test('a host run whose turn-start capture failed has no Changes review, visibly', async () => {
  const paused = await pausedHostRun({ failStart: true });
  const { resolver } = mainResolver(paused.service, clientSource(paused.client));
  const view = await resolver.resolveView({
    kind: 'agent-run',
    runId: paused.runId,
    threadId: paused.threadId,
  });
  expect(view.ok).toBe(false);
  expect(!view.ok && view.error).toMatch(
    /^changeset-snapshot-capture-failed: .*the shadow repository is unavailable/
  );
});
test('a host run that ended without its turn end, or recorded no turn, has no Changes review, visibly', async () => {
  const shadow = await temporaryDirectory('bs-m3-host-changes-shadow-');
  const service = createSnapshotService({
    runner: fixtureSnapshotGitRunner,
    snapshotsBaseDir: shadow,
  });
  const threadId = randomUUID();
  const recovered = randomUUID();
  // Rows exactly as the host commits them, for a run recovered after a restart.
  const rows = [
    {
      event: {
        boundary: 'turn-start',
        roots: [{ commitOid: 'a'.repeat(40), rootId: ROOT_ID, rootPath: '/workspace' }],
        runId: recovered,
        type: 'workspace.snapshot.recorded',
      },
      seq: 1,
      threadId,
    },
    { event: { outcome: 'interrupted', runId: recovered, type: 'run.finished' }, seq: 2, threadId },
  ].map((row) =>
    Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })(row)
  );
  const { resolver } = mainResolver(service, {
    listThreads: async () => new Set([threadId]),
    readRows: async (_threadId, fromSeq) => rows.filter((row) => row.seq > fromSeq),
  });
  const ended = await resolver.resolveView({ kind: 'agent-run', runId: recovered, threadId });
  expect(!ended.ok && ended.error).toMatch(
    /^changeset-snapshot-missing: .*ended without recording its turn-end snapshots/
  );
  const unrecorded = await resolver.resolveView({
    kind: 'agent-run',
    runId: randomUUID(),
    threadId,
  });
  expect(!unrecorded.ok && unrecorded.error).toMatch(
    /^changeset-snapshot-missing: .*recorded no workspace snapshots/
  );
});
test('a thread the host does not own refuses instead of reading a retired ledger', async () => {
  const shadow = await temporaryDirectory('bs-m3-host-changes-shadow-');
  const service = createSnapshotService({
    runner: fixtureSnapshotGitRunner,
    snapshotsBaseDir: shadow,
  });
  const { resolver } = mainResolver(service, {
    listThreads: async () => new Set(['some-host-thread']),
    readRows: () => {
      throw new Error('a thread the host does not own is never read from it');
    },
  });
  const view = await resolver.resolveView({
    kind: 'agent-run',
    runId: 'legacy-run',
    threadId: 'legacy-thread',
  });
  expect(!view.ok && view.error).toMatch(
    /^changeset-snapshot-missing: .*is not owned by the agent host/
  );
});
