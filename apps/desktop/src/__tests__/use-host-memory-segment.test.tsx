// @vitest-environment jsdom

import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  HOST_METHOD_SCHEMAS,
  HOST_RESULT_SCHEMAS,
  type HostLogRow,
  HostLogRowSchema,
  type HostMethod,
  type HostParams,
  type HostResults,
} from '@brainstrike/agent-host/protocol';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import richRecording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type HostMemoryRowSource,
  hostOmMeterState,
  useHostMemorySegment,
  withMemoryGate,
} from '../renderer/use-host-memory-segment';

type MemoryRead = HostResults['thread/memory/read'];
const THREAD = 'thread-memory-segment';
const REQUEST: HostParams<'thread/memory/read'> = {
  modelId: 'openai::gpt-6-sol',
  threadId: THREAD,
};
/** Stable, as the thread view's callback is: a new identity is a new request to read. */
const readRequest = (): HostParams<'thread/memory/read'> => REQUEST;
const rows = richRecording.map((row) => HostLogRowSchema.parse(row));
const finished = rows.find(({ event }) => event.type === 'run.finished');
const chunk = rows.find(({ event }) => event.type === 'stream.chunk');
const started = rows.find(({ event }) => event.type === 'run.started');
if (!(finished && chunk && started && started.event.type === 'run.started')) {
  throw new Error('The recorded run must start, stream and finish');
}
// Core commits an observer call in memory.usage's shape (see host-thread-ledger.test.ts).
const observerCall = HostLogRowSchema.parse({
  event: {
    kind: 'observation',
    modelId: 'openai::gpt-5-mini',
    runId: started.event.runId,
    type: 'memory.usage',
    usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
  },
  seq: 1000,
  threadId: started.threadId,
});

class RowSource implements HostMemoryRowSource {
  private snapshot: { readonly rows: readonly HostLogRow[] } = { rows: [] };
  private readonly listeners = new Set<() => void>();
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  commit(row: HostLogRow): void {
    this.snapshot = { rows: [...this.snapshot.rows, row] };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** A host client that answers `thread/memory/read` through the wire schema, in order. */
function memoryClient(
  answer: (params: HostParams<'thread/memory/read'>) => Promise<MemoryRead>
): Pick<HostClient, 'request'> {
  return {
    request: async <Method extends HostMethod>(
      method: Method,
      params: HostParams<Method>
    ): Promise<HostResults[Method]> => {
      if (method !== 'thread/memory/read') {
        throw new Error(`Unexpected host request ${method}`);
      }
      const read: MemoryRead = HOST_RESULT_SCHEMAS['thread/memory/read'].parse(
        await answer(HOST_METHOD_SCHEMAS['thread/memory/read'].parse(params))
      );
      return read as HostResults[Method];
    },
  };
}

function hostClient(...answers: MemoryRead[]) {
  const request = vi.fn(async (_params: HostParams<'thread/memory/read'>) => {
    const answer = answers.shift();
    if (!answer) {
      throw new Error('No recorded memory read left');
    }
    return answer;
  });
  return { client: memoryClient(request), request };
}

const ACTIVE: MemoryRead = {
  admission: { ready: true },
  observational: {
    record: {
      bufferedObservationTokens: 120,
      messageTokenThreshold: 30_000,
      observationTokenCount: 900,
      pendingMessageTokens: 4000,
      totalTokensObserved: 5900,
    },
    state: 'active',
  },
};
const NOT_READY: MemoryRead = {
  admission: { ready: false, reason: 'Semantic recall needs its embedding model downloaded.' },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the meter reads the host memory state the next send would admit', () => {
  test('each observational state maps onto the meter segment', () => {
    expect(hostOmMeterState({ state: 'off' })).toEqual({ kind: 'inactive' });
    expect(hostOmMeterState({ reason: 'keys-unknown', state: 'awaiting-observer' })).toEqual({
      kind: 'awaiting-observer',
      reason: 'keys-unknown',
    });
    expect(hostOmMeterState({ record: null, state: 'active' })).toEqual({ kind: 'empty' });
    if (!('observational' in ACTIVE)) {
      throw new Error('ACTIVE is a ready read');
    }
    expect(hostOmMeterState(ACTIVE.observational)).toEqual({
      bufferedObservationTokens: 120,
      compactionSavedTokens: 5000,
      kind: 'stats',
      messageTokenThreshold: 30_000,
      observationTokens: 900,
      pendingMessageTokens: 4000,
    });
  });

  test('a memory precondition gates the send after any notice that already gates it', () => {
    const refused = { admissionReason: 'Semantic recall needs its embedding model downloaded.' };
    const provider = { disabledReason: 'Add an OpenAI key to send', isComposerDisabled: true };
    expect(withMemoryGate(provider, refused)).toEqual(provider);
    expect(withMemoryGate({ disabledReason: 'Model discovery is stale' }, refused)).toEqual({
      disabledReason: 'Semantic recall needs its embedding model downloaded.',
      isComposerDisabled: true,
    });
    expect(withMemoryGate({}, { omSegment: { kind: 'empty' } })).toEqual({});
  });

  test('a ready read fills the segment, and a not-ready read names why the send is refused', async () => {
    const { client, request } = hostClient(ACTIVE);
    const ready = renderHook(() =>
      useHostMemorySegment({ blocked: false, catalog: '', client, readRequest, source: undefined })
    );
    expect(ready.result.current).toEqual({ omSegment: { kind: 'loading' } });
    await waitFor(() => expect(ready.result.current.omSegment).toMatchObject({ kind: 'stats' }));
    expect(request).toHaveBeenCalledWith(REQUEST);
    const refused = hostClient(NOT_READY);
    const notReady = renderHook(() =>
      useHostMemorySegment({
        blocked: false,
        catalog: '',
        client: refused.client,
        readRequest,
        source: undefined,
      })
    );
    await waitFor(() =>
      expect(notReady.result.current).toEqual({
        admissionReason: 'Semantic recall needs its embedding model downloaded.',
      })
    );
  });

  test('while another notice gates the send, nothing is read', () => {
    const { client, request } = hostClient();
    const buildRequest = vi.fn(readRequest);
    const { result } = renderHook(() =>
      useHostMemorySegment({
        blocked: true,
        catalog: '',
        client,
        readRequest: buildRequest,
        source: undefined,
      })
    );
    expect(result.current).toEqual({});
    expect(buildRequest).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  test('a committed memory call or run end re-reads; a streamed chunk does not', async () => {
    const { client, request } = hostClient(ACTIVE, ACTIVE, ACTIVE);
    const source = new RowSource();
    renderHook(() =>
      useHostMemorySegment({ blocked: false, catalog: '', client, readRequest, source })
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    act(() => source.commit(chunk));
    act(() => source.commit(observerCall));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    act(() => source.commit(finished));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  });

  test('a re-render that builds an equal request reads nothing more', async () => {
    const { client, request } = hostClient(ACTIVE, ACTIVE);
    // The thread view's request callback changes identity on every render.
    const { rerender, result } = renderHook(
      ({ build }: { build: () => HostParams<'thread/memory/read'> }) =>
        useHostMemorySegment({
          blocked: false,
          catalog: '',
          client,
          readRequest: build,
          source: undefined,
        }),
      { initialProps: { build: () => ({ ...REQUEST }) } }
    );
    await waitFor(() => expect(result.current.omSegment).toMatchObject({ kind: 'stats' }));
    rerender({ build: () => ({ ...REQUEST }) });
    rerender({ build: () => ({ ...REQUEST }) });
    expect(result.current.omSegment).toMatchObject({ kind: 'stats' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('enabling the selected model re-reads the same request, so its gate clears', async () => {
    const disabled: MemoryRead = {
      admission: { ready: false, reason: 'The selected catalog model is disabled' },
    };
    const { client, request } = hostClient(disabled, ACTIVE);
    const { rerender, result } = renderHook(
      ({ catalog }: { catalog: string }) =>
        useHostMemorySegment({ blocked: false, catalog, client, readRequest, source: undefined }),
      { initialProps: { catalog: 'openrouter::other-model' } }
    );
    await waitFor(() =>
      expect(result.current.admissionReason).toBe('The selected catalog model is disabled')
    );
    // The catalog admission reads gained the selected model; the request is unchanged.
    rerender({ catalog: 'openrouter::other-model\nopenai::gpt-6-sol' });
    await waitFor(() => expect(result.current.omSegment).toMatchObject({ kind: 'stats' }));
    expect(result.current.admissionReason).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('a new request or a memory-settings change re-reads', async () => {
    const { client, request } = hostClient(ACTIVE, ACTIVE, ACTIVE);
    const planned = { ...REQUEST, planMode: true as const };
    const { rerender, result } = renderHook(
      ({ build }: { build: () => HostParams<'thread/memory/read'> }) =>
        useHostMemorySegment({
          blocked: false,
          catalog: '',
          client,
          readRequest: build,
          source: undefined,
        }),
      { initialProps: { build: readRequest } }
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    // Plan mode turned on: the thread view builds a new request.
    rerender({ build: () => planned });
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(planned));
    await act(async () => {
      useAssistantMemoryPreferencesStore.setState({});
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.omSegment).toMatchObject({ kind: 'stats' }));
  });

  test('only the latest read publishes, and a rejected read is the segment error', async () => {
    let answerFirst: (value: MemoryRead) => void = () => undefined;
    const request = vi
      .fn<(params: HostParams<'thread/memory/read'>) => Promise<MemoryRead>>()
      .mockImplementationOnce(
        () =>
          new Promise<MemoryRead>((resolve) => {
            answerFirst = resolve;
          })
      )
      .mockRejectedValueOnce(new Error('The agent host connection closed'));
    const client = memoryClient(request);
    const source = new RowSource();
    const { result } = renderHook(() =>
      useHostMemorySegment({ blocked: false, catalog: '', client, readRequest, source })
    );
    act(() => source.commit(finished));
    await waitFor(() =>
      expect(result.current.omSegment).toEqual({
        kind: 'error',
        reason: 'The agent host connection closed',
      })
    );
    await act(async () => answerFirst(ACTIVE));
    expect(result.current.omSegment).toEqual({
      kind: 'error',
      reason: 'The agent host connection closed',
    });
  });
});
