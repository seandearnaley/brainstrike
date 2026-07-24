import type { CreateResumeRunConfig, ThreadMessage } from '@assistant-ui/react';
import { act, renderHook } from '@testing-library/react';
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
      { eventId: 'session-1:-1', runId: 'run-1' },
      storage
    );

    expect(readAssistantActiveRunSession('thread-1', storage)).toEqual({
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
        record: { eventId: 'session-1:-1', runId: 'run-1' },
        runtime,
        stream,
      })
    );

    expect(resumeRun).not.toHaveBeenCalled();

    act(() => {
      state = {
        isLoading: false,
        isRunning: false,
        messages: [message('user-1', 'user')],
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

    act(() => {
      for (const listener of listeners) {
        listener();
      }
    });
    expect(resumeRun).toHaveBeenCalledTimes(1);
  });
});
