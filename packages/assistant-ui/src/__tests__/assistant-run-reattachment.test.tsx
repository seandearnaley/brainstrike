import {
  AssistantRuntimeProvider,
  type CreateResumeRunConfig,
  type ThreadMessage,
  useLocalRuntime,
} from '@assistant-ui/react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  type AssistantReplayMessageIdentityRef,
  beginAssistantReplay,
  clearAssistantActiveRunSession,
  readAssistantActiveRunSession,
  remapAssistantReplayHistoryItem,
  restoreDiscoveredRunInput,
  useAssistantRunReattachment,
  writeAssistantActiveRunSession,
} from '../assistant-run-reattachment';

const message = (id: string, role: ThreadMessage['role']): ThreadMessage =>
  ({
    content: [{ text: id, type: 'text' }],
    createdAt: new Date(0),
    id,
    metadata: { custom: {} },
    role,
  }) as ThreadMessage;

describe('assistant active-run session storage', () => {
  it('round-trips and clears a thread-scoped replay record', () => {
    const storage = window.sessionStorage;
    storage.clear();

    writeAssistantActiveRunSession(
      'thread-1',
      { assistantMessageId: 'assistant-1', eventId: 'session-1:-1', runId: 'run-1' },
      storage
    );

    expect(readAssistantActiveRunSession('thread-1', storage)).toEqual({
      assistantMessageId: 'assistant-1',
      eventId: 'session-1:-1',
      runId: 'run-1',
    });
    clearAssistantActiveRunSession('thread-1', storage);
    expect(readAssistantActiveRunSession('thread-1', storage)).toBeUndefined();
  });

  it('rejects malformed persisted replay state instead of silently degrading', () => {
    const storage = window.sessionStorage;
    storage.clear();
    storage.setItem('brainstrike.assistant.active-run:thread-1', '{"eventId":3}');

    expect(() => readAssistantActiveRunSession('thread-1', storage)).toThrow(
      'Stored assistant active-run session is malformed'
    );
  });
});

describe('useAssistantRunReattachment', () => {
  it('rebuilds an unsaved first user turn from host discovery before replay', async () => {
    let runtime: ReturnType<typeof useLocalRuntime> | undefined;
    const Harness = () => {
      const currentRuntime = useLocalRuntime({
        async run() {
          throw new Error('Replay must not start a second model request.');
        },
      });
      useEffect(() => {
        runtime = currentRuntime;
      }, [currentRuntime]);
      return <AssistantRuntimeProvider runtime={currentRuntime} />;
    };
    render(<Harness />);
    await waitFor(() => expect(runtime?.thread.getState().isLoading).toBe(false));
    const discoveredRun = {
      assistantMessageId: 'assistant-live',
      eventId: 'session:0',
      inputMessage: {
        id: 'user-1',
        parts: [{ text: 'prompt', type: 'text' as const }],
        role: 'user' as const,
      },
      inputParentMessageId: null,
      parentMessageId: 'user-1',
      runId: 'run-live',
      state: 'active' as const,
    };
    const identityRef: AssistantReplayMessageIdentityRef = { current: null };
    act(() => {
      if (!runtime) {
        throw new Error('Test runtime did not initialize.');
      }
      restoreDiscoveredRunInput(runtime, discoveredRun);
      beginAssistantReplay({
        durableMessageId: 'assistant-live',
        identityRef,
        parentMessageId: 'user-1',
        runtime,
        async *stream() {
          yield {
            content: [{ text: 'replayed', type: 'text' as const }],
            status: { reason: 'stop' as const, type: 'complete' as const },
          };
        },
      });
    });
    await waitFor(() => expect(runtime?.thread.getState().isRunning).toBe(false));
    expect(runtime?.thread.getState().messages.map((item) => item.id)).toEqual([
      'user-1',
      'assistant-live',
    ]);
  });

  it('replays a running host message before its assistant row is durable', async () => {
    const initialMessages = [message('user-1', 'user')];
    let runtime: ReturnType<typeof useLocalRuntime> | undefined;
    const Harness = () => {
      const currentRuntime = useLocalRuntime(
        {
          async run() {
            throw new Error('Replay must not start a second model request.');
          },
        },
        { initialMessages }
      );
      useEffect(() => {
        runtime = currentRuntime;
      }, [currentRuntime]);
      return <AssistantRuntimeProvider runtime={currentRuntime} />;
    };
    render(<Harness />);
    await waitFor(() => expect(runtime?.thread.getState().isLoading).toBe(false));
    const identityRef: AssistantReplayMessageIdentityRef = { current: null };
    act(() => {
      if (!runtime) {
        throw new Error('Test runtime did not initialize.');
      }
      beginAssistantReplay({
        durableMessageId: 'assistant-live',
        identityRef,
        parentMessageId: 'user-1',
        runtime,
        async *stream() {
          yield {
            content: [{ text: 'replayed', type: 'text' as const }],
            status: { reason: 'stop' as const, type: 'complete' as const },
          };
        },
      });
    });
    await waitFor(() => expect(runtime?.thread.getState().isRunning).toBe(false));
    expect(runtime?.thread.getState().messages.map((item) => item.id)).toEqual([
      'user-1',
      'assistant-live',
    ]);
  });

  it('resumes into the durable assistant message instead of creating a sibling', async () => {
    const initialMessages = [message('user-1', 'user'), message('assistant-1', 'assistant')];
    let runtime: ReturnType<typeof useLocalRuntime> | undefined;
    const Harness = () => {
      const currentRuntime = useLocalRuntime(
        {
          async run() {
            throw new Error('The normal model run must not execute during replay.');
          },
        },
        { initialMessages }
      );
      useEffect(() => {
        runtime = currentRuntime;
      }, [currentRuntime]);
      return <AssistantRuntimeProvider runtime={currentRuntime} />;
    };
    render(<Harness />);
    const identityRef: AssistantReplayMessageIdentityRef = { current: null };
    const stream = async function* () {
      yield {
        content: [{ text: 'replayed', type: 'text' as const }],
        status: { reason: 'stop' as const, type: 'complete' as const },
      };
    };

    await waitFor(() =>
      expect(runtime?.thread.getState().messages.map((item) => item.id)).toEqual([
        'user-1',
        'assistant-1',
      ])
    );
    act(() => {
      if (!runtime) {
        throw new Error('Test runtime did not initialize.');
      }
      beginAssistantReplay({
        durableMessageId: 'assistant-1',
        identityRef,
        runtime,
        stream,
      });
    });

    await waitFor(() => expect(runtime?.thread.getState().isRunning).toBe(false));
    expect(runtime?.thread.getState().messages.map((item) => item.id)).toEqual([
      'user-1',
      'assistant-1',
    ]);
    expect(runtime?.thread.getState().messages.at(-1)?.content).toEqual([
      { text: 'replayed', type: 'text' },
    ]);
  });

  it('retains the durable assistant identity when replay closes without a terminal chunk', async () => {
    const initialMessages = [message('user-1', 'user'), message('assistant-1', 'assistant')];
    let runtime: ReturnType<typeof useLocalRuntime> | undefined;
    const Harness = () => {
      const currentRuntime = useLocalRuntime(
        {
          async run() {
            throw new Error('The normal model run must not execute during replay.');
          },
        },
        { initialMessages }
      );
      useEffect(() => {
        runtime = currentRuntime;
      }, [currentRuntime]);
      return <AssistantRuntimeProvider runtime={currentRuntime} />;
    };
    render(<Harness />);
    const identityRef: AssistantReplayMessageIdentityRef = { current: null };
    const stream = async function* () {
      yield {
        content: [{ text: 'partial replay', type: 'text' as const }],
      };
    };

    await waitFor(() => expect(runtime?.thread.getState().isLoading).toBe(false));
    act(() => {
      if (!runtime) {
        throw new Error('Test runtime did not initialize.');
      }
      beginAssistantReplay({
        durableMessageId: 'assistant-1',
        identityRef,
        runtime,
        stream,
      });
    });

    await waitFor(() => expect(runtime?.thread.getState().isRunning).toBe(false));
    expect(runtime?.thread.getState().messages.map((item) => item.id)).toEqual([
      'user-1',
      'assistant-1',
    ]);
    expect(runtime?.thread.getState().messages.at(-1)?.status).toMatchObject({
      reason: 'unknown',
      type: 'complete',
    });
  });

  it('waits for history hydration and resumes exactly once from the current head', () => {
    const listeners = new Set<() => void>();
    let state = {
      isLoading: true,
      isRunning: false,
      messages: [] as ThreadMessage[],
    };
    const resumeRun = vi.fn(() => {
      state = {
        ...state,
        messages: [...state.messages, message('generated-1', 'assistant')],
      };
    });
    const identityRef: AssistantReplayMessageIdentityRef = { current: null };
    const runtime = {
      thread: {
        export: () => ({
          headId: state.messages.at(-1)?.id ?? null,
          messages: state.messages.map((currentMessage, index) => ({
            message: currentMessage,
            parentId: state.messages[index - 1]?.id ?? null,
          })),
        }),
        getState: () => state,
        import: (repository: {
          messages: Array<{ message: ThreadMessage; parentId: string | null }>;
        }) => {
          state = { ...state, messages: repository.messages.map((item) => item.message) };
        },
        resumeRun,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        unstable_on: vi.fn(() => vi.fn()),
      },
    };
    const stream = vi.fn() as unknown as NonNullable<CreateResumeRunConfig['stream']>;

    renderHook(() =>
      useAssistantRunReattachment({
        identityRef,
        record: {
          assistantMessageId: 'assistant-1',
          eventId: 'session-1:-1',
          runId: 'run-1',
        },
        replayRetryToken: 0,
        runtime,
        stream,
      })
    );

    expect(resumeRun).not.toHaveBeenCalled();

    act(() => {
      state = {
        isLoading: false,
        isRunning: false,
        messages: [message('user-1', 'user'), message('assistant-1', 'assistant')],
      };
      for (const listener of listeners) {
        listener();
      }
    });

    expect(resumeRun).toHaveBeenCalledTimes(1);
    expect(resumeRun).toHaveBeenCalledWith({
      parentId: 'user-1',
      runConfig: {},
      stream,
    });
    expect(identityRef.current).toEqual({
      durableMessageId: 'assistant-1',
      generatedMessageId: 'generated-1',
    });

    act(() => {
      for (const listener of listeners) {
        listener();
      }
    });
    expect(resumeRun).toHaveBeenCalledTimes(1);
  });

  it('permits one bounded reattachment retry after a transient replay failure', () => {
    const listeners = new Set<() => void>();
    const state = {
      isLoading: false,
      isRunning: false,
      messages: [message('user-1', 'user'), message('assistant-1', 'assistant')],
    };
    let generatedCount = 0;
    const resumeRun = vi.fn(() => {
      generatedCount += 1;
      state.messages = [...state.messages, message(`generated-${generatedCount}`, 'assistant')];
    });
    const identityRef: AssistantReplayMessageIdentityRef = { current: null };
    const runtime = {
      thread: {
        export: () => ({
          headId: state.messages.at(-1)?.id ?? null,
          messages: state.messages.map((currentMessage, index) => ({
            message: currentMessage,
            parentId: state.messages[index - 1]?.id ?? null,
          })),
        }),
        getState: () => state,
        import: (repository: {
          messages: Array<{ message: ThreadMessage; parentId: string | null }>;
        }) => {
          state.messages = repository.messages.map((item) => item.message);
        },
        resumeRun,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        unstable_on: vi.fn(() => vi.fn()),
      },
    };
    const stream = vi.fn() as unknown as NonNullable<CreateResumeRunConfig['stream']>;
    const record = {
      assistantMessageId: 'assistant-1',
      eventId: 'session-1:-1',
      runId: 'run-1',
    };
    const { rerender } = renderHook(
      ({ replayRetryToken }) =>
        useAssistantRunReattachment({
          identityRef,
          record,
          replayRetryToken,
          runtime,
          stream,
        }),
      { initialProps: { replayRetryToken: 0 } }
    );

    expect(resumeRun).toHaveBeenCalledTimes(1);
    state.messages = [message('user-1', 'user'), message('assistant-1', 'assistant')];
    identityRef.current = null;
    rerender({ replayRetryToken: 1 });
    expect(resumeRun).toHaveBeenCalledTimes(2);
    rerender({ replayRetryToken: 1 });
    expect(resumeRun).toHaveBeenCalledTimes(2);
  });

  it('persists a replayed assistant message under its durable identity', () => {
    const item = {
      message: message('generated-1', 'assistant'),
      parentId: 'user-1',
    };

    expect(
      remapAssistantReplayHistoryItem(item, {
        durableMessageId: 'assistant-1',
        generatedMessageId: 'generated-1',
      })
    ).toEqual({
      message: { ...item.message, id: 'assistant-1' },
      parentId: 'user-1',
    });
  });

  it('rejects replay when the durable assistant message already has descendants', () => {
    const runtime = {
      thread: {
        export: () => ({
          headId: 'user-2',
          messages: [
            { message: message('user-1', 'user'), parentId: null },
            { message: message('assistant-1', 'assistant'), parentId: 'user-1' },
            { message: message('user-2', 'user'), parentId: 'assistant-1' },
          ],
        }),
        getState: () => ({
          isLoading: false,
          isRunning: false,
          messages: [] as ThreadMessage[],
        }),
        import: vi.fn(),
        resumeRun: vi.fn(),
        subscribe: vi.fn(),
        unstable_on: vi.fn(() => vi.fn()),
      },
    };

    expect(() =>
      beginAssistantReplay({
        durableMessageId: 'assistant-1',
        identityRef: { current: null },
        runtime,
        stream: vi.fn() as unknown as NonNullable<CreateResumeRunConfig['stream']>,
        syntheticPauseMessageId: 'suspended-approval:other-run:other-call',
      })
    ).toThrow('because it already has descendants');
    expect(runtime.thread.import).not.toHaveBeenCalled();
    expect(runtime.thread.resumeRun).not.toHaveBeenCalled();
  });
});
