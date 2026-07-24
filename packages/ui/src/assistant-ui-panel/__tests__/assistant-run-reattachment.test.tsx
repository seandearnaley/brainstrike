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
  clearAssistantActiveRunSession,
  readAssistantActiveRunSession,
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
      runtime?.thread.resumeRun({
        assistantMessageId: 'assistant-1',
        parentId: 'user-1',
        runConfig: {},
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

  it('waits for history hydration and resumes exactly once from the current head', () => {
    const listeners = new Set<() => void>();
    let state = {
      isLoading: true,
      isRunning: false,
      messages: [] as ThreadMessage[],
    };
    const resumeRun = vi.fn();
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
        resumeRun,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    };
    const stream = vi.fn() as unknown as NonNullable<CreateResumeRunConfig['stream']>;

    renderHook(() =>
      useAssistantRunReattachment({
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
      assistantMessageId: 'assistant-1',
      parentId: 'user-1',
      runConfig: {},
      stream,
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
      messages: [message('user-1', 'user')],
    };
    const resumeRun = vi.fn();
    const runtime = {
      thread: {
        export: () => ({
          headId: 'user-1',
          messages: [{ message: state.messages[0] as ThreadMessage, parentId: null }],
        }),
        getState: () => state,
        resumeRun,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
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
          record,
          replayRetryToken,
          runtime,
          stream,
        }),
      { initialProps: { replayRetryToken: 0 } }
    );

    expect(resumeRun).toHaveBeenCalledTimes(1);
    rerender({ replayRetryToken: 1 });
    expect(resumeRun).toHaveBeenCalledTimes(2);
    rerender({ replayRetryToken: 1 });
    expect(resumeRun).toHaveBeenCalledTimes(2);
  });
});
