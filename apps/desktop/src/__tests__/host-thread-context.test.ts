/**
 * BST-2021: a subagent's lane reads its thread's committed log through the
 * host and folds it as the thread's own view does. The rows are a recorded
 * host log (`committed-host-rewinds.json`): runs A and B, a rewind to before
 * B, its redo, a second rewind, then run C answering from A.
 */
import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  HOST_RESULT_SCHEMAS,
  HostLogRowSchema,
  type HostMethod,
  type HostParams,
} from '@brainstrike/agent-host/protocol';
import recording from '@brainstrike/test-utils/fixtures/committed-host-rewinds.json';
import { Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { openHostThreadContext } from '../renderer/host-thread-context';

const rows = recording.map((row) =>
  Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })(row)
);
const threadId = rows[0]?.threadId ?? '';
const [runA, runB, runC] = rows.flatMap(({ event }) =>
  event.type === 'run.started' ? [event.runId] : []
);
function recordedClient(subscribe: () => Promise<unknown> = async () => ({ rows, telemetry: [] })) {
  const closed = Promise.withResolvers<void>();
  const request = vi.fn(async (method: HostMethod, _params: HostParams<HostMethod>) => {
    const answers: Partial<Record<HostMethod, () => unknown>> = {
      'log/subscribe': subscribe,
      'log/unsubscribe': () => ({ unsubscribed: true }),
    };
    const answer = answers[method];
    if (!answer) {
      throw new Error(`Unexpected host request ${method}`);
    }
    return Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS[method], {
      errors: 'all',
      onExcessProperty: 'error',
    })(await answer());
  });
  const client = {
    closed: closed.promise,
    onEvent: vi.fn(() => () => undefined),
    onTelemetry: vi.fn(() => () => undefined),
    request: request as unknown as HostClient['request'],
  };
  return { client, lose: () => closed.resolve(), request };
}
describe('openHostThreadContext', () => {
  it("folds the thread's log on its displayed branch, and releases only its own subscription", async () => {
    const { client, request } = recordedClient();
    const source = openHostThreadContext(client, threadId);
    expect(source.getSnapshot()).toEqual({ isLoading: true });
    const changed = vi.fn();
    source.subscribe(changed);
    await vi.waitFor(() => expect(source.getSnapshot().record).toBeDefined());
    const { record } = source.getSnapshot();
    expect(record?.branchRunIds).toEqual([runA, runC]);
    expect([...(record?.snapshot.runs.keys() ?? [])]).toEqual([runA, runB, runC]);
    expect(source.getSnapshot().error).toBeUndefined();
    expect(changed).toHaveBeenCalled();
    source.close();
    expect(request).toHaveBeenCalledWith('log/unsubscribe', { threadId });
  });
  it('keeps the map and says so when the host connection closes', async () => {
    const { client, lose } = recordedClient();
    const source = openHostThreadContext(client, threadId);
    await vi.waitFor(() => expect(source.getSnapshot().record).toBeDefined());
    lose();
    await vi.waitFor(() =>
      expect(source.getSnapshot().error).toBe('The agent host connection closed.')
    );
    expect(source.getSnapshot().record?.branchRunIds).toEqual([runA, runC]);
    source.close();
  });
  it('reports a refused subscription as a failure, never as an empty thread', async () => {
    const { client } = recordedClient(async () => {
      throw new Error('subscription refused');
    });
    const source = openHostThreadContext(client, threadId);
    await vi.waitFor(() => expect(source.getSnapshot().isLoading).toBe(false));
    // The session's own description of a boundary failure.
    expect(source.getSnapshot().error).toBe(
      'Something went wrong. The details were recorded in the diagnostic log.'
    );
    expect(source.getSnapshot().record).toBeUndefined();
    source.close();
  });
});
