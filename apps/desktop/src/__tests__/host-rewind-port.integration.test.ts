// @vitest-environment node
/**
 * The rewind modal's host port over a real agent host (BST-1977, gap 2): the
 * host's own preview, rewind and redo answers become the modal's model, and
 * the preview's tree is Main's `run-range` from the preview's `fromRunId`.
 * The platform's snapshot owner is the only stand-in: it answers each file's
 * restore as the desktop owner would, with nothing on disk.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachAgentHost,
  type HostClient,
  type HostRewindFiles,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { Changeset, ChangesetView } from '@brainstrike/types';
import { afterEach, expect, test, vi } from 'vitest';
import { createHostRewindPort } from '../renderer/host-rewind-port';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

const ROOT = { rootId: 'root-1', rootPath: '/workspace/project' };
const oid = (digit: string) => digit.repeat(40);

async function hostThread(files: HostRewindFiles) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-host-rewind-port-'));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  let turn = 0;
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      admitRun: async () => ({
        captureTurnBoundary: async (request) => [
          { ...ROOT, commitOid: oid(request.boundary === 'turn-start' ? String(++turn) : 'e') },
        ],
        configuration: {},
        model: scriptedModel(),
        snapshot: { configuration: {}, maxSteps: 2, toolIdentities: {} },
        tools: {},
      }),
      close: async () => undefined,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      rewindFiles: files,
    }
  );
  cleanup.push(() => host.close());
  const client = await attachAgentHost(host.record);
  cleanup.push(() => client.close());
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const send = async (prompt: string) => {
    const commandId = randomUUID();
    const { runId } = await client.request('run/start', {
      commandId,
      modelId: 'scripted',
      prompt,
      threadId,
    });
    await expect
      .poll(async () =>
        (await client.request('thread/read', { fromSeq: 0, threadId })).rows.some(
          ({ event }) => event.type === 'run.finished' && event.runId === runId
        )
      )
      .toBe(true);
    return { messageId: commandId, runId };
  };
  return { client, send, threadId };
}

function changes() {
  const resolveView = vi.fn(
    async (_rootId: string, changeset: Changeset) =>
      ({
        ok: true,
        value: {
          changeset,
          files: [
            {
              additions: 1,
              deletions: 1,
              path: 'notes.txt',
              repositoryRoot: null,
              revertible: true,
              rootId: ROOT.rootId,
              status: 'modified',
              worktreePath: null,
            },
          ],
          totalAdditions: 1,
          totalDeletions: 1,
        } satisfies ChangesetView,
      }) as const
  );
  return { fileDiff: vi.fn(), resolveView };
}

function files(overrides: Partial<HostRewindFiles> = {}): HostRewindFiles {
  return {
    apply: async () => [
      { path: 'notes.txt', rootId: ROOT.rootId, status: 'restored' },
      {
        detail: 'it is open in another editor',
        path: 'b.txt',
        rootId: ROOT.rootId,
        status: 'failed',
      },
      { path: 'vendor/lib', rootId: ROOT.rootId, status: 'skipped-nested-repo' },
    ],
    drift: async () => [],
    preview: async () => ({ previewId: 'preview-1' }),
    redo: async () => [{ path: 'notes.txt', rootId: ROOT.rootId, status: 'restored' }],
    redoConflicts: async () => [],
    ...overrides,
  };
}

async function ready(
  port: ReturnType<typeof createHostRewindPort>,
  threadId: string,
  messageId: string
) {
  const preview = await port.preview({ messageId, threadId });
  if (!(preview.ok && preview.value.ok)) {
    throw new Error('the host previewed the rewind');
  }
  return preview.value;
}

test('a host rewind previews its branch and restore, applies, and undoes through the port', async () => {
  const thread = await hostThread(files());
  await thread.send('First');
  const second = await thread.send('Second');
  const bridge = changes();
  const port = createHostRewindPort(thread.client as HostClient, bridge);

  const preview = await ready(port, thread.threadId, second.messageId);
  expect(preview).toMatchObject({
    changeset: { fromRunId: second.runId, kind: 'run-range', threadId: thread.threadId },
    conflicts: [],
    conversation: { kind: 'branched', turns: 1 },
    filesScope: { available: true },
    previewId: 'preview-1',
    restoreRoots: [ROOT],
  });
  expect(bridge.resolveView).toHaveBeenCalledWith(ROOT.rootId, preview.changeset);

  const applied = await port.apply({
    acknowledgeConflicts: false,
    mode: 'conversation-and-files',
    preview,
  });
  expect(applied).toEqual({
    ok: true,
    value: {
      ok: true,
      outcome: {
        conversation: { kind: 'branched', turns: 1 },
        notRestored: [
          { message: 'it is open in another editor', path: 'b.txt', rootId: ROOT.rootId },
          {
            message: 'inside a nested repository; left as it is',
            path: 'vendor/lib',
            rootId: ROOT.rootId,
          },
        ],
        roots: [{ ...ROOT, attempted: 3, conflicts: 0, failed: 2, label: null, restored: 1 }],
      },
      rewindId: expect.any(String),
    },
  });
  if (!(applied.ok && applied.value.ok)) {
    throw new Error('the rewind applied');
  }

  const redone = await port.redo({
    acknowledgeConflicts: false,
    rewindId: applied.value.rewindId,
    roots: [ROOT],
    threadId: thread.threadId,
  });
  expect(redone).toEqual({
    ok: true,
    value: {
      description: 'The conversation and its files are back where they were.',
      ok: true,
      roots: [ROOT],
    },
  });
});

test('files that changed after the preview are named, and nothing applies until acknowledged', async () => {
  const thread = await hostThread(
    files({ drift: async () => [{ path: 'notes.txt', rootId: ROOT.rootId }] })
  );
  const first = await thread.send('First');
  const port = createHostRewindPort(thread.client as HostClient, changes());
  const preview = await ready(port, thread.threadId, first.messageId);

  await expect(
    port.apply({ acknowledgeConflicts: false, mode: 'conversation-and-files', preview })
  ).resolves.toEqual({
    ok: true,
    value: {
      conflicts: [
        {
          forceable: true,
          message: 'changed after the preview',
          path: 'notes.txt',
          rootId: ROOT.rootId,
          rootLabel: null,
        },
      ],
      message: '1 file(s) changed after the preview and nothing was applied: notes.txt.',
      ok: false,
      redoable: null,
    },
  });
  const rows = (
    await thread.client.request('thread/read', { fromSeq: 0, threadId: thread.threadId })
  ).rows;
  expect(rows.some(({ event }) => event.type.startsWith('thread.rew'))).toBe(false);
});

test('a target the Changes header names by its run previews that run’s user message', async () => {
  const thread = await hostThread(files());
  await thread.send('First');
  const second = await thread.send('Second');
  const port = createHostRewindPort(thread.client as HostClient, changes());
  await expect(
    port.preview({ runId: second.runId, threadId: thread.threadId })
  ).resolves.toMatchObject({
    ok: true,
    value: { changeset: { fromRunId: second.runId }, messageId: second.messageId, ok: true },
  });
});
