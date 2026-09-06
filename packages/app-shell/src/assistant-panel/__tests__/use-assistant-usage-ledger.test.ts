/**
 * Contract tests for the extracted usage ledger (BST-1652).
 *
 * The ledger owns every write into the session context-usage store and the
 * durable run-usage rows. These cover the seams that a re-extraction could
 * quietly change: the cumulative load, the DERIVED "no durable sink" null, and
 * both live-sum settle paths.
 */
import type {
  AssistantThreadRepository,
  RecordRunUsageInput,
  ThreadCumulativeUsage,
} from '@brainstrike/assistant-data';
import { resetContextUsageStore, useContextUsageStore } from '@brainstrike/assistant-ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantRunUsagePayload } from '../../assistant-ui-panel-wrapper-runtime';
import {
  type UseAssistantUsageLedgerInput,
  useAssistantUsageLedger,
} from '../use-assistant-usage-ledger';

const THREAD_ID = 'thread-1';

const CUMULATIVE: ThreadCumulativeUsage = {
  perModel: [
    {
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      inputTokens: 1000,
      model: 'gpt-test',
      outputTokens: 100,
      provider: 'openai',
      runKind: 'chat',
    },
  ],
  totalInputTokens: 1000,
  totalOutputTokens: 100,
};

function createRepositoryStub(
  overrides: Partial<AssistantThreadRepository> = {}
): AssistantThreadRepository {
  return {
    appendThreadRunEvent: async () => {},
    completeThreadRun: async () => {},
    createThread: async () => {
      throw new Error('not used');
    },
    createThreadRun: async () => {
      throw new Error('not used');
    },
    deleteThread: async () => {},
    getCrossRootUsage: async () => [],
    getThreadCumulativeUsage: async () => CUMULATIVE,
    listLatestThreadRuns: async () => [],
    listMessages: async () => [],
    listThreadCheckpoints: async () => [],
    listThreadRunEvents: async () => [],
    listThreads: async () => [],
    recordRunUsage: async () => {},
    renameThread: async () => {},
    updateThreadMetadata: async () => {},
    ...overrides,
  };
}

function createInput(
  overrides: Partial<UseAssistantUsageLedgerInput> = {}
): UseAssistantUsageLedgerInput {
  return {
    assistantThreadRepository: createRepositoryStub(),
    completePreparedRequest: async () => {},
    getActiveRunUsageContext: () => ({
      model: 'gpt-test',
      provider: 'openai',
      rootId: null,
      runId: 'run-1',
    }),
    getProviderLlmModels: () => [],
    localChatTransport: 'data-stream',
    memoryResourceId: 'resource-1',
    prepareRequestData: async () => ({ memory: {} }),
    refreshThreadsAfterRun: () => {},
    selectedMemoryThreadId: THREAD_ID,
    selectedProvider: 'openai',
    ...overrides,
  };
}

const USAGE: AssistantRunUsagePayload = { inputTokens: 500, outputTokens: 50 };

describe('useAssistantUsageLedger', () => {
  beforeEach(() => {
    resetContextUsageStore();
  });

  it('loads the durable thread total for the selected thread', async () => {
    // The input object is built ONCE: the hook's seams (repo handle, callbacks)
    // are stable identities in the wrapper (useMemo/useCallback), and rebuilding
    // them per render would re-fire the load effect forever.
    const input = createInput();
    const { result } = renderHook(() => useAssistantUsageLedger(input));
    await waitFor(() => expect(result.current.cumulativeUsage).not.toBeNull());
    expect(result.current.cumulativeUsage?.totalTokens).toBe(1100);
  });

  it('DERIVES a null thread total when there is no durable sink', async () => {
    // Web (no repo) and "no thread selected" are not events to react to — they
    // are facts about this render's inputs. Nulling from the load effect would
    // paint a stale total for a frame AND put a synchronous setState in an
    // effect (BST-1652).
    const { rerender, result } = renderHook(
      (input: UseAssistantUsageLedgerInput) => useAssistantUsageLedger(input),
      { initialProps: createInput() }
    );
    await waitFor(() => expect(result.current.cumulativeUsage).not.toBeNull());

    rerender(createInput({ selectedMemoryThreadId: undefined }));
    // Same render pass — no effect, no waitFor.
    expect(result.current.cumulativeUsage).toBeNull();

    rerender(createInput({ assistantThreadRepository: null }));
    expect(result.current.cumulativeUsage).toBeNull();
  });

  it('records a durable row and clears the live sum once the refresh lands', async () => {
    const recordRunUsage = vi.fn(async () => {});
    const input = createInput({
      assistantThreadRepository: createRepositoryStub({ recordRunUsage }),
    });
    const { result } = renderHook(() => useAssistantUsageLedger(input));
    act(() => {
      result.current.handleStepUsage({ inputTokens: 400, outputTokens: 40 });
    });
    expect(useContextUsageStore.getState().liveRunUsageByThread[THREAD_ID]).toEqual({
      inputTokens: 400,
      outputTokens: 40,
    });

    act(() => {
      result.current.handleUsage(USAGE);
    });
    await waitFor(() => expect(recordRunUsage).toHaveBeenCalledTimes(1));
    const [row] = recordRunUsage.mock.calls[0] as unknown as [RecordRunUsageInput];
    expect(row).toMatchObject({ inputTokens: 500, model: 'gpt-test', threadId: THREAD_ID });
    await waitFor(() =>
      expect(useContextUsageStore.getState().liveRunUsageByThread[THREAD_ID]).toBeUndefined()
    );
    expect(useContextUsageStore.getState().usageByThread[THREAD_ID]).toEqual({
      inputTokens: 500,
      outputTokens: 50,
    });
  });

  it('claims the live sum for the settle window before the durable write, and releases it after', async () => {
    // `thread.isRunning` is already false by the time handleUsage runs, so
    // without this claim the reader hides the run's tokens until the refreshed
    // cumulative lands and the headline dips and jumps on every run. Deferring
    // the write lets the window be observed rather than raced through.
    let releaseWrite: () => void = () => undefined;
    const writeLanded = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const recordRunUsage = vi.fn(async () => {
      await writeLanded;
    });
    const input = createInput({
      assistantThreadRepository: createRepositoryStub({ recordRunUsage }),
    });
    const { result } = renderHook(() => useAssistantUsageLedger(input));
    act(() => {
      result.current.handleStepUsage({ inputTokens: 400, outputTokens: 40 });
    });

    act(() => {
      result.current.handleUsage(USAGE);
    });
    await waitFor(() => expect(recordRunUsage).toHaveBeenCalledTimes(1));

    // Mid-window: the run has finished streaming and its row is not absorbed yet.
    expect(useContextUsageStore.getState().settlingRunUsageByThread[THREAD_ID]).toBe(true);
    expect(useContextUsageStore.getState().liveRunUsageByThread[THREAD_ID]).toEqual({
      inputTokens: 400,
      outputTokens: 40,
    });

    releaseWrite();
    await waitFor(() =>
      expect(useContextUsageStore.getState().liveRunUsageByThread[THREAD_ID]).toBeUndefined()
    );
    // The claim must not outlive the sum it protects.
    expect(useContextUsageStore.getState().settlingRunUsageByThread[THREAD_ID]).toBeUndefined();
  });

  it('starts the live sum from zero when a new run begins on a thread holding a stranded one', async () => {
    // A run the user switches away from mid-stream never settles under the
    // thread it started on: handleStepUsage AND both settle-side clears key off
    // the CURRENT selection, so the partial sum is stranded on the thread the
    // user left. The meter's isRunning gate hides it only while that thread is
    // idle — the next run on it flips isRunning true, re-exposing the stranded
    // tokens and accumulating the new run's steps on top of them for the whole
    // run (the headline stays inflated and its cost stays suppressed).
    // Composing a request IS a run starting, so the sum resets there.
    const prepareRequestData = vi.fn(async () => ({ memory: {} }));
    const input = createInput({ prepareRequestData });
    const { result } = renderHook(() => useAssistantUsageLedger(input));
    await waitFor(() => expect(result.current.cumulativeUsage).not.toBeNull());

    // Strand a partial sum on this thread, as a mid-stream switch away would.
    act(() => {
      result.current.handleStepUsage({ inputTokens: 90_000, outputTokens: 10_000 });
    });
    expect(useContextUsageStore.getState().liveRunUsageByThread[THREAD_ID]).toBeDefined();

    // The user comes back and sends again: a new run starts on this thread.
    await act(async () => {
      await result.current.prepareRequestAndResetLiveUsage();
    });
    expect(useContextUsageStore.getState().liveRunUsageByThread[THREAD_ID]).toBeUndefined();
    expect(prepareRequestData).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.handleStepUsage({ inputTokens: 400, outputTokens: 40 });
    });
    const live = useContextUsageStore.getState().liveRunUsageByThread[THREAD_ID];
    expect(live).toEqual({ inputTokens: 400, outputTokens: 40 });
    // The meter's headline is `cumulativeUsage.totalTokens + live` — the new
    // run's 440 tokens on the durable 1,100, NOT the stranded 100,000 too.
    const headlineTokens =
      (result.current.cumulativeUsage?.totalTokens ?? 0) +
      (live ? live.inputTokens + live.outputTokens : 0);
    expect(headlineTokens).toBe(1540);
  });

  it('settles the live sum on a non-completed terminal status only', async () => {
    const completePreparedRequest = vi.fn(async () => {});
    const input = createInput({ completePreparedRequest });
    const { result } = renderHook(() => useAssistantUsageLedger(input));
    act(() => {
      result.current.handleStepUsage({ inputTokens: 400, outputTokens: 40 });
    });

    await act(async () => {
      await result.current.completeRequestAndSettleLiveUsage(undefined, 'completed');
    });
    // 'completed' rides handleUsage's post-refresh clear — settling here would
    // make the thread total dip before the durable row lands.
    expect(useContextUsageStore.getState().liveRunUsageByThread[THREAD_ID]).toBeDefined();

    await act(async () => {
      await result.current.completeRequestAndSettleLiveUsage(undefined, 'cancelled');
    });
    expect(useContextUsageStore.getState().liveRunUsageByThread[THREAD_ID]).toBeUndefined();
    expect(completePreparedRequest).toHaveBeenCalledTimes(2);
  });
});
