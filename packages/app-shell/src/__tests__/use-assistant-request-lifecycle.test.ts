import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssistantForegroundActivityForTests,
  getAssistantForegroundActivitySnapshot,
} from '../assistant-foreground-activity';
import type { AssistantThreadRepository } from '../assistant-memory-repository';
import { useAssistantRequestLifecycle } from '../hooks/use-assistant-request-lifecycle';

function createRepositoryStub(
  overrides: Partial<AssistantThreadRepository> = {}
): AssistantThreadRepository {
  return {
    appendThreadRunEvent: vi.fn(),
    completeThreadRun: vi.fn(async () => {}),
    createThread: vi.fn(),
    createThreadRun: vi.fn(async (input) => ({ ...input, createdAt: 0, status: 'running' })),
    getThreadCumulativeUsage: vi.fn(async () => null),
    recordRunUsage: vi.fn(),
    deleteThread: vi.fn(),
    listLatestThreadRuns: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    listThreadRunEvents: vi.fn(async () => []),
    listThreads: vi.fn(async () => []),
    renameThread: vi.fn(),
    updateThreadMetadata: vi.fn(),
    ...overrides,
  };
}

const baseRequestData = {
  enabledNativeToolIds: ['filesystem.read_file'],
  memory: {
    resourceId: 'workspace-a',
    threadId: 'thread-a',
  },
  workspaceRootPath: '/workspace-a',
};

describe('useAssistantRequestLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetAssistantForegroundActivityForTests();
    vi.useRealTimers();
  });

  it('creates a run record, injects its id into memory, and releases the lease on completion', async () => {
    const repository = createRepositoryStub({
      createThreadRun: vi.fn(async (input) => ({
        ...input,
        createdAt: 0,
        id: 'run-a',
        status: 'running',
      })),
    });

    const { result } = renderHook(() =>
      useAssistantRequestLifecycle({
        assistantThreadRepository: repository,
        memoryResourceId: 'workspace-a',
        modelSettings: { maxOutputTokens: 512 },
        providerOptions: { openai: { reasoningEffort: 'medium' } },
        requestData: baseRequestData,
        resolvedModelName: 'gpt-5.2',
        selectedMemoryThreadId: 'thread-a',
        selectedProvider: 'openai',
      })
    );

    const prepared = await act(async () => result.current.prepareRequestData());

    expect(repository.createThreadRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^run-/),
        model: 'gpt-5.2',
        modelSettings: { maxOutputTokens: 512 },
        provider: 'openai',
        providerOptions: { openai: { reasoningEffort: 'medium' } },
        resourceId: 'workspace-a',
        runtimeKind: 'hosted',
        threadId: 'thread-a',
      })
    );
    expect(prepared).toMatchObject({
      enabledNativeToolIds: ['filesystem.read_file'],
      memory: {
        resourceId: 'workspace-a',
        runId: 'run-a',
        threadId: 'thread-a',
      },
    });
    expect(getAssistantForegroundActivitySnapshot()).toBe(true);

    act(() => {
      result.current.renewActiveAssistantForegroundActivity();
    });
    expect(getAssistantForegroundActivitySnapshot()).toBe(true);

    await act(async () => {
      await result.current.completePreparedRequest(prepared, 'completed');
    });

    expect(repository.completeThreadRun).toHaveBeenCalledWith('run-a', { status: 'completed' });
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
  });

  it('snapshots the request-start model/provider so usage is attributed to the run that produced the tokens, not a later picker change', async () => {
    const repository = createRepositoryStub({
      createThreadRun: vi.fn(async (input) => ({
        ...input,
        createdAt: 0,
        id: 'run-attribution',
        status: 'running',
      })),
    });

    // First render: the picker has openai/gpt-5.2 selected.
    interface PickerProps {
      model: string;
      provider: 'anthropic' | 'openai';
    }
    const { result, rerender } = renderHook(
      (props: PickerProps) =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          providerOptions: undefined,
          requestData: baseRequestData,
          resolvedModelName: props.model,
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: props.provider,
        }),
      { initialProps: { provider: 'openai', model: 'gpt-5.2' } as PickerProps }
    );

    // No run in flight yet.
    expect(result.current.getActiveRunUsageContext()).toBeNull();

    // Start a request — snapshots openai/gpt-5.2.
    await act(async () => {
      await result.current.prepareRequestData();
    });

    // The user switches the picker to a DIFFERENT model MID-RUN (before usage fires).
    rerender({ provider: 'anthropic', model: 'claude-opus-4-8' });

    // The active run's usage context must still reflect the REQUEST-START model,
    // not the new picker selection.
    expect(result.current.getActiveRunUsageContext()).toEqual({
      runId: 'run-attribution',
      provider: 'openai',
      model: 'gpt-5.2',
    });

    // After completion the snapshot is cleared.
    const prepared = { memory: { runId: 'run-attribution' } };
    await act(async () => {
      await result.current.completePreparedRequest(prepared, 'completed');
    });
    expect(result.current.getActiveRunUsageContext()).toBeNull();
  });

  it('releases any active foreground lease on unmount', async () => {
    const { result, unmount } = renderHook(() =>
      useAssistantRequestLifecycle({
        assistantThreadRepository: createRepositoryStub({
          createThreadRun: vi.fn(async (input) => ({
            ...input,
            createdAt: 0,
            id: 'run-unmount',
            status: 'running',
          })),
        }),
        memoryResourceId: 'workspace-a',
        modelSettings: undefined,
        providerOptions: undefined,
        requestData: baseRequestData,
        resolvedModelName: 'gpt-5.2',
        selectedMemoryThreadId: 'thread-a',
        selectedProvider: 'openai',
      })
    );

    await act(async () => result.current.prepareRequestData());
    expect(getAssistantForegroundActivitySnapshot()).toBe(true);

    unmount();

    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
  });

  it('throws when prepared memory context is missing', async () => {
    const { result } = renderHook(() =>
      useAssistantRequestLifecycle({
        assistantThreadRepository: createRepositoryStub(),
        memoryResourceId: 'workspace-a',
        modelSettings: undefined,
        providerOptions: undefined,
        requestData: { enabledNativeToolIds: [] },
        resolvedModelName: 'gpt-5.2',
        selectedMemoryThreadId: 'thread-a',
        selectedProvider: 'openai',
      })
    );

    await expect(result.current.prepareRequestData()).rejects.toThrow(
      'Assistant request preparation requires Mastra memory context.'
    );
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
  });

  it('requires a repository when completing prepared run data', async () => {
    const { result } = renderHook(() =>
      useAssistantRequestLifecycle({
        assistantThreadRepository: null,
        memoryResourceId: 'workspace-a',
        modelSettings: undefined,
        providerOptions: undefined,
        requestData: baseRequestData,
        resolvedModelName: 'gpt-5.2',
        selectedMemoryThreadId: 'thread-a',
        selectedProvider: 'openai',
      })
    );

    await expect(
      result.current.completePreparedRequest(
        {
          memory: { runId: 'run-a' },
        },
        'failed',
        'boom'
      )
    ).rejects.toThrow('Assistant run completion requires an active thread repository.');
  });
});
