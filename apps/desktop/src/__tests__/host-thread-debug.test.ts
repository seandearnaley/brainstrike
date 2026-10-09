import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  HOST_RESULT_SCHEMAS,
  type HostLogRow,
  HostLogRowSchema,
  type HostMethod,
  type HostParams,
  type HostResults,
} from '@brainstrike/agent-host/protocol';
import questionRecording from '@brainstrike/test-utils/fixtures/committed-host-question.json';
// A completed run whose first attempt stalled and recovered, then a run whose
// stalled attempt was refused (it had tool parts) and failed.
import attemptsRecording from '@brainstrike/test-utils/fixtures/committed-host-run-attempts.json';
import { describe, expect, test, vi } from 'vitest';
import {
  collectHostThreadDebugBundleData,
  createHostDebugBundleBinding,
} from '../renderer/host-thread-debug';

const MODEL = 'openrouter::anthropic/claude-sonnet-4.6';
const rows: HostLogRow[] = attemptsRecording.map((raw) => {
  const row = HostLogRowSchema.parse(raw);
  return row.event.type === 'run.started'
    ? { ...row, event: { ...row.event, modelId: MODEL } }
    : row;
});
const childRows = questionRecording.map((raw) => HostLogRowSchema.parse(raw));
const threadId = rows[0]?.threadId ?? '';
const childThreadId = childRows[0]?.threadId ?? '';
const [completedRun, failedRun] = rows.flatMap((row) =>
  row.event.type === 'run.started' ? [row.event.runId] : []
);
if (!(completedRun && failedRun && childThreadId !== threadId)) {
  throw new Error('The recordings need two runs and a second thread');
}
const STALL = 'The model stream stalled after 400ms without output.';

/** The host's read methods over recorded logs; the root delegated to the child. */
function recordedHost(): Pick<HostClient, 'request'> {
  const logs = new Map([
    [threadId, rows],
    [childThreadId, childRows],
  ]);
  const answer = (method: HostMethod, params: HostParams<HostMethod>): unknown => {
    const id = 'threadId' in params ? params.threadId : undefined;
    if (method === 'thread/read' && id) {
      return { rows: logs.get(id) ?? [] };
    }
    if (method === 'thread/children') {
      return {
        children:
          id === threadId
            ? [
                {
                  callSign: 'Scout',
                  color: 'teal',
                  origin: {
                    background: false,
                    depth: 1,
                    parentRunId: failedRun,
                    parentThreadId: threadId,
                    persona: 'scout',
                    toolCallId: 'call-1',
                    turnId: 'turn-1',
                  },
                  threadId: childThreadId,
                },
              ]
            : [],
      };
    }
    throw new Error(`Unexpected host read: ${method}`);
  };
  return {
    request: async <Method extends HostMethod>(
      method: Method,
      params: HostParams<Method>
    ): Promise<HostResults[Method]> =>
      HOST_RESULT_SCHEMAS[method].parse(answer(method, params)) as HostResults[Method],
  };
}

/** The renderer diagnostic store with no correlated events. */
const noDiagnostics = { query: vi.fn(async () => ({ rows: [] })) };

describe("a host thread's debug bundle, from its committed log", () => {
  test('selects the failed run: its finish detail, refused attempt and no provider call', () => {
    const data = collectHostThreadDebugBundleData(rows, { runId: null, threadId });
    expect(data.run).toMatchObject({
      error: STALL,
      id: failedRun,
      model: 'anthropic/claude-sonnet-4.6',
      provider: 'openrouter',
      runtimeKind: 'agent-host',
      status: 'failed',
    });
    expect(data.runEvents.map(({ kind, status }) => [kind, status])).toEqual([
      ['run.started', null],
      ['run.attempt', 'refused'],
      ['run.finished', 'failed'],
    ]);
    expect(data.usage).toEqual([]);
    expect(data.runError).toBeNull();
    // Both prompts and the completed run's step messages, oldest first.
    expect(data.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  test('a named run: its recovered attempt, its step without the messages, and its usage', () => {
    const data = collectHostThreadDebugBundleData(rows, { runId: completedRun, threadId });
    expect(data.run).toMatchObject({ error: null, id: completedRun, status: 'completed' });
    expect(data.runEvents.map(({ kind, status }) => [kind, status])).toEqual([
      ['run.started', null],
      ['run.attempt', 'recovered'],
      ['model.step', null],
      ['run.finished', 'completed'],
    ]);
    const step = data.runEvents.find((event) => event.kind === 'model.step');
    expect(step?.metadata).not.toHaveProperty('messages');
    expect(data.usage).toEqual([
      expect.objectContaining({
        billedCostUsd: null,
        model: 'anthropic/claude-sonnet-4.6',
        provider: 'openrouter',
      }),
    ]);
  });

  test('the Copy debug bundle formats it with the legacy bundle sections', async () => {
    const binding = createHostDebugBundleBinding(recordedHost(), threadId, noDiagnostics);
    const bundle = await binding.buildBundle({ runId: null });
    expect(bundle).toContain('# BrainStrike Debug Bundle');
    expect(bundle).toContain(`run_id: ${failedRun}`);
    expect(bundle).toContain('- status: failed');
    expect(bundle).toContain(`- error: ${STALL}`);
    expect(bundle).toContain('- runtime_kind: agent-host');
    expect(bundle).toContain('### Event 25 — run.attempt / refused');
  });

  test('the thread pack holds the root and delegated child logs with their manifest', async () => {
    const binding = createHostDebugBundleBinding(recordedHost(), threadId, noDiagnostics);
    if (!binding.buildThreadPack) {
      throw new Error('A host thread offers its debug pack');
    }
    const pack = JSON.parse(await binding.buildThreadPack());
    expect(pack.format).toBe('brainstrike-host-thread-debug-pack');
    expect(
      pack.sections.threads.map((thread: { parentThreadId: string | null; threadId: string }) => [
        thread.threadId,
        thread.parentThreadId,
      ])
    ).toEqual([
      [threadId, null],
      [childThreadId, threadId],
    ]);
    expect(pack.sections.threads[0].rows).toHaveLength(rows.length);
    expect(pack.manifest).toMatchObject({
      activeRunIds: [],
      counts: { rows: rows.length + childRows.length, threads: 2 },
      rootThreadId: threadId,
    });
    // jsdom has no desktop diagnostics bridge: the manifest names the gap.
    expect(pack.manifest.host.hostLog).toMatch(/^unavailable: no desktop diagnostics bridge/u);
    expect(pack.sections.hostLog).toBeNull();
  });
});
