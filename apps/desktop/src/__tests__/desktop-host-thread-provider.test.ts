import type { HostClient } from '@brainstrike/agent-host/browser';
import { type HostLedgerThread, ThreadLedgerFold } from '@brainstrike/agent-host/ledger-projection';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_RESULT_SCHEMAS,
  type HostLogRow,
  HostLogRowSchema,
  type HostMethod,
  type HostParams,
  type HostResults,
} from '@brainstrike/agent-host/protocol';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import questionRecording from '@brainstrike/test-utils/fixtures/committed-host-question.json';
import costedRecording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json';
import { afterEach, expect, test, vi } from 'vitest';
import { createWindowThreadCapability } from '../renderer/desktop-host-thread-capability';
// Original thread creation rows from the ordinary app-owned SQLite GUI receipt.
import richRecording from './fixtures/committed-app-owned-host-thread.json';

const connect = vi.hoisted(() => vi.fn<() => Promise<HostClient>>());
vi.mock('../renderer/agent-host-client', () => ({ connectDesktopAgentHost: connect }));

const richRows = richRecording.map((row) => HostLogRowSchema.parse(row));
const questionRows = questionRecording.map((row) => HostLogRowSchema.parse(row));
// Two recorded runs, committed with a catalog model and a commit time on every row.
const costedRows = costedRecording.map((raw, index) => {
  const row = HostLogRowSchema.parse(raw);
  const event =
    row.event.type === 'run.started'
      ? { ...row.event, modelId: 'openrouter::anthropic/claude-sonnet-4.6' }
      : row.event;
  return { ...row, event, ts: Date.parse('2026-10-08T12:00:00Z') + index * 1000 };
});
const firstThread = richRows[0]?.threadId;
const laterThread = questionRows[0]?.threadId;
if (!(firstThread && laterThread && firstThread !== laterThread)) {
  throw new Error('Recorded independent Core threads are required');
}

function fixture() {
  const request = vi.fn<(method: HostMethod, params: HostParams<HostMethod>) => Promise<unknown>>();
  const client: HostClient = {
    close: vi.fn(async () => undefined),
    closed: Promise.resolve(),
    onChildrenChanged: vi.fn(() => () => undefined),
    onEvent: vi.fn(() => () => undefined),
    record: {
      endpoint: '/tmp/recorded-host-fixture',
      hostVersion: '0.1.0',
      pid: process.pid,
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      start: 'synthetic client fixture',
      token: 'a'.repeat(64),
    },
    request: async <Method extends HostMethod>(
      method: Method,
      params: HostParams<Method>
    ): Promise<HostResults[Method]> =>
      HOST_RESULT_SCHEMAS[method].parse(await request(method, params)) as HostResults[Method],
  };
  connect.mockResolvedValue(client);
  return {
    capability: createWindowThreadCapability(({ host, threadId }) => (host ? threadId : undefined)),
    request,
  };
}

afterEach(async () => {
  window.dispatchEvent(new Event('beforeunload'));
  await Promise.resolve();
  vi.clearAllMocks();
});

/** A `thread/list` entry as Core serves it, from a thread's recorded creation time. */
function catalogEntry(threadId: string, rows: readonly HostLogRow[]) {
  const createdAt = rows.find((row) => row.event.type === 'thread.started')?.ts ?? 0;
  return { binding: null, createdAt, threadId, updatedAt: createdAt };
}

/** Core's `ledger/read` entry for a thread whose committed log is `rows`, under `threadId`. */
function ledgerEntry(threadId: string, rows: readonly HostLogRow[]): HostLedgerThread {
  const fold = new ThreadLedgerFold();
  for (const row of rows) {
    fold.apply({ ...row, threadId });
  }
  return { threadId, ...fold.read() };
}

test('deletion recognizes a Core thread committed after the visible catalog was hydrated', async () => {
  const { capability, request } = fixture();
  request
    .mockResolvedValueOnce({ threads: [catalogEntry(firstThread, richRows)] })
    .mockResolvedValueOnce({ threads: [] })
    .mockResolvedValueOnce({
      threads: [catalogEntry(firstThread, richRows), catalogEntry(laterThread, questionRows)],
    })
    .mockResolvedValueOnce({ deleted: true, threadIds: [laterThread] });
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(await capability.deleteThread(laterThread)).toBe(true);
  expect(request).toHaveBeenLastCalledWith('thread/delete', { threadId: laterThread });
});

test('a failed Core-owned deletion retains the visible owner and rejects', async () => {
  const { capability, request } = fixture();
  const failure = new Error('The native deletion owner did not join');
  request
    .mockResolvedValueOnce({ threads: [catalogEntry(firstThread, richRows)] })
    .mockResolvedValueOnce({ threads: [] })
    .mockResolvedValueOnce({ threads: [catalogEntry(firstThread, richRows)] })
    .mockRejectedValueOnce(failure);
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  await expect(capability.deleteThread(firstThread)).rejects.toBe(failure);
  expect(capability.renderThread(firstThread, true)).toBeDefined();
});

test('deleting a thread drops every thread Core deleted with it from the runs and the ledger', async () => {
  const { capability, request } = fixture();
  // A delegating thread and its child, each with its own costed runs.
  const child = 'delegated-child-thread';
  const costed = costedRows.filter((row) => row.threadId === costedRows[0]?.threadId);
  const finished = costed.findLast((row) => row.event.type === 'run.finished');
  request
    .mockResolvedValueOnce({
      threads: [
        {
          ...catalogEntry(firstThread, richRows),
          latestRun: {
            completedAt: finished?.ts ?? null,
            needsInput: false,
            seq: finished?.seq ?? 1,
            status: 'completed',
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      threads: [ledgerEntry(firstThread, costed), ledgerEntry(child, costed)],
    })
    .mockResolvedValueOnce({ threads: [catalogEntry(firstThread, richRows)] })
    .mockResolvedValueOnce({ deleted: true, threadIds: [child, firstThread] });
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(new Set(capability.ledger.getSnapshot().runs.map(({ threadId }) => threadId))).toEqual(
    new Set([firstThread, child])
  );
  expect(capability.runs.getSnapshot().get(firstThread)?.status).toBe('completed');
  expect(await capability.deleteThread(firstThread)).toBe(true);
  expect(capability.ledger.getSnapshot()).toEqual({ rootUsage: [], runs: [], usage: [] });
  expect(capability.runs.getSnapshot().has(firstThread)).toBe(false);
  expect(capability.renderThread(firstThread, true)).toBeUndefined();
});
