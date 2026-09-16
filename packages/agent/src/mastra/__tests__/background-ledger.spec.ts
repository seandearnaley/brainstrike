import type { BackgroundTask } from '@mastra/core/background-tasks';
import { describe, expect, it, vi } from 'vitest';
import type { StreamChunk } from '../../types';
import {
  createBackgroundLedgerSource,
  createLedgerPublisher,
  describeBackgroundWakeup,
  ledgerLabel,
  ledgerStateOf,
  makeBackgroundLedgerChunk,
  personaLabelFor,
} from '../background-ledger';

type RunEventChunk = Extract<StreamChunk, { type: 'run-event' }>;

function task(
  toolCallId: string,
  status: BackgroundTask['status'],
  extra: Partial<BackgroundTask> = {}
): BackgroundTask {
  return {
    agentId: 'root',
    args: { prompt: `Survey ${toolCallId} `.padEnd(200, 'x') },
    createdAt: new Date('2026-09-15T00:00:00Z'),
    id: `task-${toolCallId}`,
    maxRetries: 0,
    retryCount: 0,
    runId: 'root-run',
    status,
    timeoutMs: 1000,
    toolCallId,
    toolName: 'agent-explore',
    ...extra,
  };
}

const scope = { resourceId: 'owner', threadId: 'root' };
const personaLabel = (toolName: string) => (toolName === 'agent-explore' ? 'Explorer' : undefined);

/** The host's answer for an address that dispatched a child (`resolveParkedInvocation`). */
function invocationOf(parent: {
  readonly parentRuntimeRunId: string;
  readonly parentToolCallId: string;
}) {
  return {
    identity: {
      childRuntimeRunId: `${parent.parentToolCallId}-run`,
      parentRuntimeRunId: parent.parentRuntimeRunId,
      parentToolCallId: parent.parentToolCallId,
      personaId: 'explore',
    },
    resourceId: 'owner',
    threadId: `${parent.parentToolCallId}-thread`,
  };
}

function sourceOf(tasks: BackgroundTask[]) {
  const listTasks = vi.fn(async () => ({ tasks, total: tasks.length }));
  return {
    listTasks,
    source: createBackgroundLedgerSource({
      manager: { listTasks } as never,
      personaLabel,
      rejectedDelegations: undefined,
      resolveInvocation: undefined,
      scope,
    }),
  };
}

describe('ledgerStateOf', () => {
  it.each([
    ['completed', 'returned'],
    ['failed', 'failed'],
    ['timed_out', 'failed'],
    ['cancelled', 'cancelled'],
    ['pending', 'running'],
    ['running', 'running'],
    // A parked task is a host-surfaced card, never the model's business
    // (LIVE DECISIONS, 2026-09-14): to the ledger it is still in progress.
    ['suspended', 'running'],
  ] as const)('%s → %s', (status, state) => {
    expect(ledgerStateOf(status)).toBe(state);
  });
});

describe('createBackgroundLedgerSource', () => {
  it('reads the durable rows of exactly the given parent runs, in the thread scope', async () => {
    const { listTasks, source } = sourceOf([
      task('c1', 'completed'),
      task('c2', 'failed', { error: { message: 'finish reason length' } }),
      task('c3', 'cancelled'),
      task('c4', 'running'),
      task('old', 'completed', { runId: 'earlier-turn' }),
    ]);
    const ledger = await source.read(new Set(['root-run']));
    expect(listTasks).toHaveBeenCalledWith({ resourceId: 'owner', threadId: 'root' });
    expect(ledger.counts).toEqual({ cancelled: 1, failed: 1, returned: 1, running: 1, total: 4 });
    expect(ledger.entries.map((entry) => [entry.toolCallId, entry.state, entry.reason])).toEqual([
      ['c1', 'returned', undefined],
      ['c2', 'failed', 'finish reason length'],
      ['c3', 'cancelled', undefined],
      ['c4', 'running', undefined],
    ]);
    expect(ledger.entries[0]).toMatchObject({ persona: 'Explorer', toolName: 'agent-explore' });
    expect(ledger.entries[0]?.prompt).toHaveLength(120);
  });

  it('leaves out a delegation rejected at start: no child ran, so it is no invocation', async () => {
    // BST-1751: the refused call still completes as a background task row.
    const listTasks = vi.fn(async () => ({
      tasks: [task('c1', 'completed'), task('c2', 'completed')],
      total: 2,
    }));
    const source = createBackgroundLedgerSource({
      manager: { listTasks } as never,
      personaLabel,
      rejectedDelegations: {
        rejected: (toolCallId, runId) => toolCallId === 'c2' && runId === 'root-run',
      },
      resolveInvocation: undefined,
      scope,
    });
    const ledger = await source.read(new Set(['root-run']));
    // MUTATION: ignoring the capture counts the refusal as returned.
    expect(ledger.counts).toEqual({ cancelled: 0, failed: 0, returned: 1, running: 0, total: 1 });
    expect(ledger.entries.map((entry) => entry.toolCallId)).toEqual(['c1']);
  });

  it('leaves out a completed delegation the host holds no invocation for, whichever leg dispatched it', async () => {
    // The capture is leg-scoped: a resume leg reads the rows of the run it
    // resumes with a capture that never saw that run's refusal. A refusal
    // persists no invocation, so the host's graph answers for every leg.
    const listTasks = vi.fn(async () => ({
      tasks: [task('c1', 'completed'), task('refused', 'completed'), task('starting', 'running')],
      total: 3,
    }));
    const source = createBackgroundLedgerSource({
      manager: { listTasks } as never,
      personaLabel,
      rejectedDelegations: undefined,
      resolveInvocation: async (parent) =>
        parent.parentToolCallId === 'c1' ? invocationOf(parent) : undefined,
      scope,
    });
    const ledger = await source.read(new Set(['root-run']));
    // MUTATION: ignoring the host's graph counts the refusal as returned.
    // MUTATION: asking about a row that has not completed drops the starting
    // child, which has not persisted its invocation yet.
    expect(ledger.entries.map((entry) => [entry.toolCallId, entry.state])).toEqual([
      ['c1', 'returned'],
      ['starting', 'running'],
    ]);
  });

  it('asks the host once per completed row: its invocation is settled before it completes', async () => {
    const listTasks = vi.fn(async () => ({ tasks: [task('refused', 'completed')], total: 1 }));
    const resolveInvocation = vi.fn(async () => undefined);
    const source = createBackgroundLedgerSource({
      manager: { listTasks } as never,
      personaLabel,
      rejectedDelegations: undefined,
      resolveInvocation,
      scope,
    });
    await source.read(new Set(['root-run']));
    const ledger = await source.read(new Set(['root-run']));
    // MUTATION: without the per-leg memo every lifecycle event asks the host
    // again for every completed row.
    expect(resolveInvocation).toHaveBeenCalledOnce();
    expect(resolveInvocation).toHaveBeenCalledWith({
      parentRuntimeRunId: 'root-run',
      parentThreadId: 'root',
      parentToolCallId: 'refused',
    });
    expect(ledger.counts.total).toBe(0);
  });

  it('asks once even when two reads overlap: the leg shares one pending answer', async () => {
    // The idle loop publishes a row per lifecycle event, so reads overlap.
    const listTasks = vi.fn(async () => ({ tasks: [task('refused', 'completed')], total: 1 }));
    const resolveInvocation = vi.fn(async () => undefined);
    const source = createBackgroundLedgerSource({
      manager: { listTasks } as never,
      personaLabel,
      rejectedDelegations: undefined,
      resolveInvocation,
      scope,
    });
    const both = await Promise.all([
      source.read(new Set(['root-run'])),
      source.read(new Set(['root-run'])),
    ]);
    // MUTATION: memoising the settled answer instead of the pending promise
    // asks the host twice for the same row.
    expect(resolveInvocation).toHaveBeenCalledOnce();
    expect(both.map((ledger) => ledger.counts.total)).toEqual([0, 0]);
  });

  it('fails the read when the host cannot answer, and asks again on the next read', async () => {
    // NO SILENT DEGRADATION: answering "not refused" on a host error would
    // count a refusal as returned — the defect the graph exists to answer. A
    // failed read publishes no row (`background_ledger_read_failed`) and fails
    // the wakeup loudly, as every ledger read failure already does.
    const listTasks = vi.fn(async () => ({ tasks: [task('c1', 'completed')], total: 1 }));
    const resolveInvocation = vi
      .fn<() => Promise<undefined>>()
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValue(undefined);
    const source = createBackgroundLedgerSource({
      manager: { listTasks } as never,
      personaLabel,
      rejectedDelegations: undefined,
      resolveInvocation,
      scope,
    });
    // MUTATION: swallowing the error counts an unanswerable row as returned.
    await expect(source.read(new Set(['root-run']))).rejects.toThrow('host unavailable');
    // MUTATION: caching the rejected promise makes one transient failure the
    // leg's permanent answer for that row.
    await expect(source.read(new Set(['root-run']))).resolves.toMatchObject({
      counts: { cancelled: 0, failed: 0, returned: 0, running: 0, total: 0 },
    });
    expect(resolveInvocation).toHaveBeenCalledTimes(2);
  });

  it('reads the leg capture before the host: a refusal it recorded asks nothing', async () => {
    const listTasks = vi.fn(async () => ({ tasks: [task('c2', 'completed')], total: 1 }));
    const resolveInvocation = vi.fn(async () => undefined);
    const source = createBackgroundLedgerSource({
      manager: { listTasks } as never,
      personaLabel,
      rejectedDelegations: { rejected: (toolCallId) => toolCallId === 'c2' },
      resolveInvocation,
      scope,
    });
    expect((await source.read(new Set(['root-run']))).counts.total).toBe(0);
    // MUTATION: asking the host first spends a durable read on a row this leg
    // already knows it refused.
    expect(resolveInvocation).not.toHaveBeenCalled();
  });

  it('names a timed-out task as failed with the reason "timed out"', async () => {
    const { source } = sourceOf([task('c1', 'timed_out')]);
    const ledger = await source.read(new Set(['root-run']));
    expect(ledger.entries[0]).toMatchObject({ reason: 'timed out', state: 'failed' });
  });

  it('is empty without run ids and never queries', async () => {
    const { listTasks, source } = sourceOf([task('c1', 'completed')]);
    expect(await source.read(new Set())).toEqual({
      counts: { cancelled: 0, failed: 0, returned: 0, running: 0, total: 0 },
      entries: [],
    });
    expect(listTasks).not.toHaveBeenCalled();
  });
});

describe('personaLabelFor', () => {
  it('resolves the delegation tool to its persona label', () => {
    const label = personaLabelFor({
      delegationToolPersonas: new Map([['agent-explore', 'explore']]),
      personasById: new Map([['explore', { label: 'Explorer' }]]),
    });
    expect(label('agent-explore')).toBe('Explorer');
    expect(label('brainstrike_grepSearch')).toBeUndefined();
  });
});

describe('describeBackgroundWakeup', () => {
  it('lists returned, failed (with reason), cancelled and still-running invocations', async () => {
    const { source } = sourceOf([
      task('c1', 'completed'),
      task('c2', 'failed', { error: { message: 'finish reason length' } }),
      task('c3', 'cancelled'),
      task('c4', 'running'),
    ]);
    const text = describeBackgroundWakeup(await source.read(new Set(['root-run'])));
    expect(text).toContain('4 total: 1 returned, 1 failed, 1 cancelled, 1 still running');
    expect(text).toContain('c1 (agent-explore, Explorer): returned');
    expect(text).toContain('Use its saved outcome; do not execute it again.');
    expect(text).toContain('c2 (agent-explore, Explorer): failed — finish reason length');
    expect(text).toContain('Do not retry it unless the user asks.');
    expect(text).toContain('c3 (agent-explore, Explorer): cancelled by the user');
    expect(text).toContain('c4 (agent-explore, Explorer): still running');
    expect(text).toContain('Prompt: "Survey c1');
    // MUTATION: the closing sentence while something still runs is the GLM
    // failure in reverse (the root would report before the last returned).
    expect(text).not.toContain('Nothing is still running');
    expect(text).toContain(
      'Do not re-dispatch a running invocation; its outcome will be delivered.'
    );
  });

  it('says so explicitly when nothing is still running and tells the model to continue', async () => {
    const { source } = sourceOf([
      task('c1', 'completed'),
      task('c2', 'failed', { error: { message: 'boom' } }),
    ]);
    const text = describeBackgroundWakeup(await source.read(new Set(['root-run'])));
    // MUTATION: omitting this sentence reproduces the GLM run's "waiting on
    // the remaining subagents" after all four had finished.
    expect(text).toContain(
      'All 2 background invocations have finished. Nothing is still running. Continue with the task using the saved outcomes.'
    );
  });

  it('never mentions a pause: a suspended task reads as still running', async () => {
    const { source } = sourceOf([task('c1', 'suspended')]);
    const text = describeBackgroundWakeup(await source.read(new Set(['root-run'])));
    expect(text).toContain('c1 (agent-explore, Explorer): still running');
    expect(text).not.toMatch(/suspend|approval|resume/i);
  });
});

describe('ledgerLabel + makeBackgroundLedgerChunk', () => {
  it('reads "3 of 4 specialists returned · 1 running" while work runs, status running', async () => {
    const { source } = sourceOf([
      task('c1', 'completed'),
      task('c2', 'completed'),
      task('c3', 'completed'),
      task('c4', 'running'),
    ]);
    const ledger = await source.read(new Set(['root-run']));
    expect(ledgerLabel(ledger)).toBe('3 of 4 specialists returned · 1 running');
    const chunk = makeBackgroundLedgerChunk(ledger, 'root-run') as RunEventChunk;
    expect(chunk.type).toBe('run-event');
    expect(chunk.event).toMatchObject({
      kind: 'delegation.ledger',
      label: '3 of 4 specialists returned · 1 running',
      metadata: {
        cancelled: 0,
        failed: 0,
        ledgerId: 'root-run',
        returned: 3,
        running: 1,
        total: 4,
      },
      status: 'running',
    });
    expect(chunk.event.detail).toBe(
      'Explorer returned · Explorer returned · Explorer returned · Explorer running'
    );
  });

  it('completes with failures and cancellations named, and the singular for one specialist', async () => {
    const mixed = await sourceOf([
      task('c1', 'completed'),
      task('c2', 'failed', { error: { message: 'boom' } }),
      task('c3', 'cancelled'),
    ]).source.read(new Set(['root-run']));
    expect(ledgerLabel(mixed)).toBe('1 of 3 specialists returned · 1 failed · 1 cancelled');
    const chunk = makeBackgroundLedgerChunk(mixed, 'root-run') as RunEventChunk;
    expect(chunk.event.status).toBe('completed');
    const single = await sourceOf([task('c1', 'completed')]).source.read(new Set(['root-run']));
    expect(ledgerLabel(single)).toBe('1 of 1 specialist returned');
  });

  it('keeps prompts and reasons out of the persisted row', async () => {
    const ledger = await sourceOf([
      task('c1', 'failed', { error: { message: 'secret path /Users/x' } }),
    ]).source.read(new Set(['root-run']));
    const chunk = makeBackgroundLedgerChunk(ledger, 'root-run') as RunEventChunk;
    expect(JSON.stringify(chunk)).not.toContain('Survey');
    expect(JSON.stringify(chunk)).not.toContain('secret path');
  });
});

describe('createLedgerPublisher', () => {
  it('publishes one row per call and joins in-flight reads before idle resolves', async () => {
    const read = Promise.withResolvers<void>();
    const source = {
      read: vi.fn(async () => {
        await read.promise;
        return {
          counts: { cancelled: 0, failed: 0, returned: 1, running: 0, total: 1 },
          entries: [],
        };
      }),
    };
    const published: StreamChunk[] = [];
    const onSettled = vi.fn();
    const publisher = createLedgerPublisher({
      enqueue: (chunk) => {
        published.push(chunk);
        return true;
      },
      onSettled,
      source,
    });
    publisher.publish(new Set(['root-run']), 'root-run');
    expect(publisher.inFlight).toBe(1);
    let idle = false;
    const joined = publisher.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    read.resolve();
    await joined;
    expect(published).toHaveLength(1);
    expect(publisher.inFlight).toBe(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('logs and publishes nothing when the durable read fails, and still settles', async () => {
    const source = { read: vi.fn(async () => Promise.reject(new Error('db gone'))) };
    const onSettled = vi.fn();
    const publisher = createLedgerPublisher({ enqueue: () => true, onSettled, source });
    publisher.publish(new Set(['root-run']), 'root-run');
    await publisher.idle();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(publisher.inFlight).toBe(0);
  });
});
