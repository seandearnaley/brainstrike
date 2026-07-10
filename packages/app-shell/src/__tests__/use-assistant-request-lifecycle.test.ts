import { useAssistantPreferencesStore } from '@brainstrike/preferences/stores/assistant-preferences-store';
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
    deleteThread: vi.fn(),
    getCrossRootUsage: vi.fn(async () => []),
    getThreadCumulativeUsage: vi.fn(async () => null),
    listLatestThreadRuns: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    listThreadRunEvents: vi.fn(async () => []),
    listThreads: vi.fn(async () => []),
    recordRunUsage: vi.fn(),
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
    useAssistantPreferencesStore.getState().setPlanModeEnabled(false);
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
        focusedRootId: 'root-a',
        memoryResourceId: 'workspace-a',
        modelSettings: { maxOutputTokens: 512 },
        planModeAvailable: false,
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

  it('snapshots the request-start model/provider/root so usage is attributed to the run that produced the tokens, not a later picker/focus change', async () => {
    const repository = createRepositoryStub({
      createThreadRun: vi.fn(async (input) => ({
        ...input,
        createdAt: 0,
        id: 'run-attribution',
        status: 'running',
      })),
    });

    // First render: the picker has openai/gpt-5.2 and the focused root is root-a.
    interface PickerProps {
      focusedRootId: string;
      model: string;
      provider: 'anthropic' | 'openai';
    }
    const { result, rerender } = renderHook(
      (props: PickerProps) =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          focusedRootId: props.focusedRootId,
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          planModeAvailable: false,
          providerOptions: undefined,
          requestData: baseRequestData,
          resolvedModelName: props.model,
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: props.provider,
        }),
      {
        initialProps: {
          focusedRootId: 'root-a',
          model: 'gpt-5.2',
          provider: 'openai',
        } as PickerProps,
      }
    );

    // No run in flight yet.
    expect(result.current.getActiveRunUsageContext()).toBeNull();

    // Start a request — snapshots openai/gpt-5.2 + root-a.
    await act(async () => {
      await result.current.prepareRequestData();
    });

    // The user switches BOTH the model picker AND the focused root MID-RUN
    // (before usage fires).
    rerender({ focusedRootId: 'root-b', model: 'claude-opus-4-8', provider: 'anthropic' });

    // The active run's usage context must still reflect the REQUEST-START
    // model AND root, not the new picker/focus selection.
    expect(result.current.getActiveRunUsageContext()).toEqual({
      model: 'gpt-5.2',
      provider: 'openai',
      rootId: 'root-a',
      runId: 'run-attribution',
    });

    // After completion the snapshot is cleared.
    const prepared = { memory: { runId: 'run-attribution' } };
    await act(async () => {
      await result.current.completePreparedRequest(prepared, 'completed');
    });
    expect(result.current.getActiveRunUsageContext()).toBeNull();
  });

  it('snapshots a null root when no root is focused (honest unattributed)', async () => {
    const repository = createRepositoryStub({
      createThreadRun: vi.fn(async (input) => ({
        ...input,
        createdAt: 0,
        id: 'run-no-root',
        status: 'running',
      })),
    });

    const { result } = renderHook(() =>
      useAssistantRequestLifecycle({
        assistantThreadRepository: repository,
        focusedRootId: null,
        memoryResourceId: 'workspace-a',
        modelSettings: undefined,
        planModeAvailable: false,
        providerOptions: undefined,
        requestData: baseRequestData,
        resolvedModelName: 'gpt-5.2',
        selectedMemoryThreadId: 'thread-a',
        selectedProvider: 'openai',
      })
    );

    await act(async () => {
      await result.current.prepareRequestData();
    });

    expect(result.current.getActiveRunUsageContext()).toEqual({
      model: 'gpt-5.2',
      provider: 'openai',
      rootId: null,
      runId: 'run-no-root',
    });
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
        focusedRootId: 'root-a',
        memoryResourceId: 'workspace-a',
        modelSettings: undefined,
        planModeAvailable: false,
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
        focusedRootId: 'root-a',
        memoryResourceId: 'workspace-a',
        modelSettings: undefined,
        planModeAvailable: false,
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
        focusedRootId: 'root-a',
        memoryResourceId: 'workspace-a',
        modelSettings: undefined,
        planModeAvailable: false,
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

  describe('plan-mode freshness at the request-composition seam', () => {
    // The reviewer's option-b acceptance criterion: approving a plan calls
    // `setPlanModeEnabled(false)` and then immediately composes the resume
    // request in the SAME synchronous handler — there is no guarantee a React
    // re-render lands in between, so `requestData.planMode` (fixed at the
    // render that produced it) is not a reliable source for the composed
    // request. `prepareRequestData` must read the store's CURRENT state at
    // call time instead. These tests flip the store directly, between the
    // hook's render and the `prepareRequestData()` call, with no rerender —
    // proving the fix reads live state rather than the render-captured prop.

    it('OFF-fresh wins over a stale ON requestData snapshot (the approve-exits-plan-mode fix)', async () => {
      useAssistantPreferencesStore.getState().setPlanModeEnabled(true);
      const repository = createRepositoryStub({
        createThreadRun: vi.fn(async (input) => ({
          ...input,
          createdAt: 0,
          id: 'run-plan-exit',
          status: 'running',
        })),
      });

      // Render captures requestData with planMode:true, mirroring
      // buildAssistantRequestData's output while the toggle is on.
      const { result } = renderHook(() =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          focusedRootId: 'root-a',
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          planModeAvailable: true,
          providerOptions: undefined,
          requestData: { ...baseRequestData, planMode: true },
          resolvedModelName: 'gpt-5.2',
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: 'openai',
        })
      );

      // The approve handler flips the store off, then immediately composes
      // the request — no intervening re-render.
      useAssistantPreferencesStore.getState().setPlanModeEnabled(false);

      const prepared = await act(async () => result.current.prepareRequestData());

      // Presence-means-on: the composed request must NOT carry a truthy
      // planMode, despite the stale requestData prop saying `true`.
      expect(prepared['planMode']).toBeUndefined();
    });

    it('ON-fresh wins over a stale OFF/absent requestData snapshot (symmetric correctness)', async () => {
      useAssistantPreferencesStore.getState().setPlanModeEnabled(false);
      const repository = createRepositoryStub({
        createThreadRun: vi.fn(async (input) => ({
          ...input,
          createdAt: 0,
          id: 'run-plan-enter',
          status: 'running',
        })),
      });

      // Render captures requestData with no planMode key at all (the toggle
      // was off at render time).
      const { result } = renderHook(() =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          focusedRootId: 'root-a',
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          planModeAvailable: true,
          providerOptions: undefined,
          requestData: baseRequestData,
          resolvedModelName: 'gpt-5.2',
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: 'openai',
        })
      );

      // The toggle flips on after render, still with no intervening re-render.
      useAssistantPreferencesStore.getState().setPlanModeEnabled(true);

      const prepared = await act(async () => result.current.prepareRequestData());

      expect(prepared['planMode']).toBe(true);
    });

    it('planModeAvailable=false gates plan mode off even when the store is on (built-in local provider)', async () => {
      useAssistantPreferencesStore.getState().setPlanModeEnabled(true);
      const repository = createRepositoryStub({
        createThreadRun: vi.fn(async (input) => ({
          ...input,
          createdAt: 0,
          id: 'run-plan-unavailable',
          status: 'running',
        })),
      });

      const { result } = renderHook(() =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          focusedRootId: 'root-a',
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          planModeAvailable: false,
          providerOptions: undefined,
          requestData: baseRequestData,
          resolvedModelName: 'gpt-5.2',
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: 'openai',
        })
      );

      const prepared = await act(async () => result.current.prepareRequestData());

      expect(prepared['planMode']).toBeUndefined();
    });
  });
});
