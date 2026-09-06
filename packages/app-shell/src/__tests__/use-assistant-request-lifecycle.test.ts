import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import {
  __resetPermissionPolicyStoreForTests,
  usePermissionPolicyStore,
} from '@brainstrike/app-state/stores/permission-policy-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssistantForegroundActivityForTests,
  ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS,
  getAssistantForegroundActivitySnapshot,
} from '../assistant-foreground-activity';
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
    listThreadCheckpoints: vi.fn(async () => []),
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
    __resetWorkspaceCollectionSyncStatusStoreForTests();
    __resetPermissionPolicyStoreForTests();
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
        permissionEnforceable: false,
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

  it('persists the first explicit thread root and pins the prepared run to it', async () => {
    const persistThreadRootBinding = vi.fn(async () => {});
    const resolveThreadRootBinding = vi.fn(async () => ({
      displayName: 'ProjectA',
      path: '/workspace-a',
      rootId: 'db-root-a',
    }));
    const repository = createRepositoryStub({
      createThreadRun: vi.fn(async (input) => ({
        ...input,
        createdAt: 0,
        id: 'run-root-bound',
        status: 'running',
      })),
    });
    const { result } = renderHook(() =>
      useAssistantRequestLifecycle({
        assistantThreadRepository: repository,
        focusedRootId: 'root-b',
        memoryResourceId: 'workspace-a',
        modelSettings: undefined,
        permissionEnforceable: false,
        persistThreadRootBinding,
        planModeAvailable: false,
        providerOptions: undefined,
        requestData: baseRequestData,
        resolvedModelName: 'gpt-5.2',
        resolveThreadRootBinding,
        selectedMemoryThreadId: 'thread-a',
        selectedProvider: 'openai',
      })
    );

    const prepared = await act(async () => result.current.prepareRequestData());

    expect(persistThreadRootBinding).toHaveBeenCalledWith({
      displayName: 'ProjectA',
      path: '/workspace-a',
      rootId: 'db-root-a',
    });
    expect(prepared).toMatchObject({
      boundWorkspaceRootId: 'db-root-a',
      mainRootId: 'db-root-a',
      mainRootPath: '/workspace-a',
    });
    expect(resolveThreadRootBinding).toHaveBeenCalledOnce();
  });

  it('does not create a run when preparation is aborted while resolving its root', async () => {
    const rootBinding = Promise.withResolvers<{
      displayName: string;
      path: string;
      rootId: string;
    }>();
    const repository = createRepositoryStub();
    const { result } = renderHook(() =>
      useAssistantRequestLifecycle({
        assistantThreadRepository: repository,
        focusedRootId: 'root-a',
        memoryResourceId: 'workspace-a',
        modelSettings: undefined,
        permissionEnforceable: false,
        persistThreadRootBinding: vi.fn(async () => {}),
        planModeAvailable: false,
        providerOptions: undefined,
        requestData: baseRequestData,
        resolvedModelName: 'gpt-5.2',
        resolveThreadRootBinding: () => rootBinding.promise,
        selectedMemoryThreadId: 'thread-a',
        selectedProvider: 'openai',
      })
    );
    const abortController = new AbortController();
    const abortError = new DOMException('The user aborted a request.', 'AbortError');
    const preparation = result.current.prepareRequestData(abortController.signal);
    const rejection = expect(preparation).rejects.toBe(abortError);

    abortController.abort(abortError);
    rootBinding.resolve({
      displayName: 'ProjectA',
      path: '/workspace-a',
      rootId: 'db-root-a',
    });

    await rejection;
    expect(repository.createThreadRun).not.toHaveBeenCalled();
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
  });

  it('keeps the first run root across an approval-style second preparation', async () => {
    const persistThreadRootBinding = vi.fn(async () => {});
    interface RootBindingProps {
      readonly rootId: string;
    }
    const { result, rerender } = renderHook(
      ({ rootId }: RootBindingProps) =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: createRepositoryStub({
            createThreadRun: vi.fn(async (input) => ({
              ...input,
              createdAt: 0,
              id: `run-${rootId}`,
              status: 'running',
            })),
          }),
          focusedRootId: rootId,
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          permissionEnforceable: false,
          persistThreadRootBinding,
          planModeAvailable: false,
          providerOptions: undefined,
          requestData: baseRequestData,
          resolvedModelName: 'gpt-5.2',
          resolveThreadRootBinding: async () => ({
            displayName: rootId,
            path: `/${rootId}`,
            rootId: `db-${rootId}`,
          }),
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: 'openai',
        }),
      { initialProps: { rootId: 'root-a' } }
    );

    const first = await act(async () => result.current.prepareRequestData());
    rerender({ rootId: 'root-b' });
    const resumed = await act(async () => result.current.prepareRequestData());

    expect(first['boundWorkspaceRootId']).toBe('db-root-a');
    expect(resumed['boundWorkspaceRootId']).toBe('db-root-a');
    expect(persistThreadRootBinding).toHaveBeenCalledTimes(1);
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
          permissionEnforceable: false,
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

  it('keeps the steerable run id alive across the foreground idle fuse, clearing it only at true completion (BST-588)', async () => {
    // The foreground-activity lease is a QoS/power concern: its 5-minute idle
    // fuse fires during silent hosted/tool gaps while the run is STILL
    // streaming. Steering must not ride that ref — a fused-out run id would
    // make the Steer button silently no-op exactly when a long run needs it.
    vi.useFakeTimers();
    try {
      const repository = createRepositoryStub({
        createThreadRun: vi.fn(async (input) => ({
          ...input,
          createdAt: 0,
          id: 'run-steerable',
          status: 'running',
        })),
      });
      const { result } = renderHook(() =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          focusedRootId: 'root-a',
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          permissionEnforceable: false,
          planModeAvailable: false,
          providerOptions: undefined,
          requestData: baseRequestData,
          resolvedModelName: 'gpt-5.2',
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: 'openai',
        })
      );

      expect(result.current.getActiveSteerableRunId()).toBeNull();
      await act(async () => {
        await result.current.prepareRequestData();
      });
      expect(result.current.getActiveSteerableRunId()).toBe('run-steerable');

      // Silent gap longer than the idle fuse: the QoS context fuses out...
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS + 1000);
      });
      expect(result.current.getActiveRunUsageContext()).toBeNull();
      // ...but the run is still in flight, so it stays steerable.
      expect(result.current.getActiveSteerableRunId()).toBe('run-steerable');

      // Only true completion clears it.
      await act(async () => {
        await result.current.completePreparedRequest(
          { memory: { runId: 'run-steerable' } },
          'completed'
        );
      });
      expect(result.current.getActiveSteerableRunId()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
        permissionEnforceable: false,
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
        permissionEnforceable: false,
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
        permissionEnforceable: false,
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
        permissionEnforceable: false,
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
          permissionEnforceable: false,
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
          permissionEnforceable: false,
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
          permissionEnforceable: false,
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

  describe('workspace-index freshness at the request-composition seam', () => {
    // The wrapper no longer live-subscribes to per-file indexing progress
    // (during initial indexing that re-rendered the whole assistant panel per
    // processed file), so `requestData.workspaceIndex` can be thousands of
    // progress patches stale by the time the user hits send. Same seam as
    // plan mode above: prepareRequestData must re-read the sync-status store
    // at call time.
    it('overrides the render-captured workspaceIndex status fields from the live store', async () => {
      const repository = createRepositoryStub({
        createThreadRun: vi.fn(async (input) => ({
          ...input,
          createdAt: 0,
          id: 'run-ws-index',
          status: 'running',
        })),
      });
      const staleWorkspaceIndex = {
        blockedReason: null,
        embeddingSetId: 'set-a',
        enabled: true,
        lastError: null,
        mode: 'auto',
        paused: false,
        queueProgress: null,
        statusState: 'idle',
      };

      const { result } = renderHook(() =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          focusedRootId: 'root-a',
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          permissionEnforceable: false,
          planModeAvailable: false,
          providerOptions: undefined,
          requestData: { ...baseRequestData, workspaceIndex: staleWorkspaceIndex },
          resolvedModelName: 'gpt-5.2',
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: 'openai',
        })
      );

      // The store advances AFTER the render that captured requestData, with
      // no re-render in between.
      act(() => {
        useWorkspaceCollectionSyncStatusStore.getState().setStatus({
          queueProgress: {
            failed: 0,
            lastError: null,
            lastEvent: null,
            pending: 3,
            processed: 7,
            totalQueued: 10,
          },
          state: 'importing',
        });
      });

      const prepared = await act(async () => result.current.prepareRequestData());

      expect(prepared['workspaceIndex']).toMatchObject({
        // Preference-shaped fields stay from the render-captured object…
        embeddingSetId: 'set-a',
        enabled: true,
        mode: 'auto',
        // …status-shaped fields are read fresh at request time.
        queueProgress: { pending: 3, processed: 7, totalQueued: 10 },
        statusState: 'importing',
      });
    });

    it('leaves requestData without workspaceIndex untouched', async () => {
      const repository = createRepositoryStub();
      const { result } = renderHook(() =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          focusedRootId: 'root-a',
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          permissionEnforceable: false,
          planModeAvailable: false,
          providerOptions: undefined,
          requestData: baseRequestData,
          resolvedModelName: 'gpt-5.2',
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: 'openai',
        })
      );

      const prepared = await act(async () => result.current.prepareRequestData());

      expect(prepared['workspaceIndex']).toBeUndefined();
    });
  });

  describe('permission-policy freshness at the request-composition seam', () => {
    // Same class of race as plan mode above: the approval notice's grant
    // actions ("Always allow" / "Allow <category> this session") write the
    // store and then, in the SAME synchronous handler, approve the pending call
    // — resuming the run through prepareRequestData. `requestData.permissionPolicyRequest`
    // is fixed at the render that produced the closure, so it must NOT be
    // trusted: prepareRequestData reads the store's CURRENT posture. These tests
    // reproduce the tight window: mutate the store AFTER the hook renders, then
    // prepare with no rerender in between.
    it('a per-tool override granted after render reaches the resumed run (the grant-and-approve race fix)', async () => {
      usePermissionPolicyStore.getState().setEnforce(true);
      const repository = createRepositoryStub({
        createThreadRun: vi.fn(async (input) => ({
          ...input,
          createdAt: 0,
          id: 'run-grant',
          status: 'running',
        })),
      });

      // Render captures requestData with NO permission snapshot, mirroring a
      // pre-grant render (nothing overridden yet).
      const { result } = renderHook(() =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          focusedRootId: 'root-a',
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          permissionEnforceable: true,
          planModeAvailable: false,
          providerOptions: undefined,
          requestData: baseRequestData,
          resolvedModelName: 'gpt-5.2',
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: 'openai',
        })
      );

      // The grant action fires here, synchronously before the resume.
      usePermissionPolicyStore.getState().setToolOverride('brainstrike.executeCommand', 'allow');

      const prepared = await act(async () => result.current.prepareRequestData());

      const snapshot = prepared['permissionPolicyRequest'] as
        | { enforce: boolean; perToolOverrides: Record<string, string> }
        | undefined;
      expect(snapshot?.enforce).toBe(true);
      expect(snapshot?.perToolOverrides['brainstrike.executeCommand']).toBe('allow');
    });

    it('permissionEnforceable=false drops the snapshot even when the store enforces (non-data-stream transport)', async () => {
      usePermissionPolicyStore.getState().setEnforce(true);
      const repository = createRepositoryStub({
        createThreadRun: vi.fn(async (input) => ({
          ...input,
          createdAt: 0,
          id: 'run-web',
          status: 'running',
        })),
      });

      const { result } = renderHook(() =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          focusedRootId: 'root-a',
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          permissionEnforceable: false,
          planModeAvailable: false,
          providerOptions: undefined,
          requestData: baseRequestData,
          resolvedModelName: 'gpt-5.2',
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: 'openai',
        })
      );

      const prepared = await act(async () => result.current.prepareRequestData());

      expect(prepared['permissionPolicyRequest']).toBeUndefined();
    });

    it('a fresh enforce=OFF drops a stale snapshot inherited from requestData', async () => {
      usePermissionPolicyStore.getState().setEnforce(false);
      const repository = createRepositoryStub({
        createThreadRun: vi.fn(async (input) => ({
          ...input,
          createdAt: 0,
          id: 'run-optout',
          status: 'running',
        })),
      });

      // requestData carries a stale enforcing snapshot (a render from before the
      // user opted out); the fresh read must override it to undefined.
      const { result } = renderHook(() =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          focusedRootId: 'root-a',
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          permissionEnforceable: true,
          planModeAvailable: false,
          providerOptions: undefined,
          requestData: {
            ...baseRequestData,
            permissionPolicyRequest: { enforce: true, perToolOverrides: {} },
          },
          resolvedModelName: 'gpt-5.2',
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: 'openai',
        })
      );

      const prepared = await act(async () => result.current.prepareRequestData());

      expect(prepared['permissionPolicyRequest']).toBeUndefined();
    });

    it('leaves the opt-in keys PRESENT with undefined values, dropped only by JSON', async () => {
      // This producer is NOT presence-means-on: an off posture is an explicit
      // `undefined`, so the key is here and only the JSON boundary removes it.
      // Rationale on the field declaration in `packages/agent/src/types.ts`.
      // `planMode` is written the same way, so it is pinned here too — the
      // stale claim this PR removes was itself an unpinned comment.
      usePermissionPolicyStore.getState().setEnforce(false);
      const repository = createRepositoryStub({
        createThreadRun: vi.fn(async (input) => ({
          ...input,
          createdAt: 0,
          id: 'run-wire-shape',
          status: 'running',
        })),
      });

      const { result } = renderHook(() =>
        useAssistantRequestLifecycle({
          assistantThreadRepository: repository,
          focusedRootId: 'root-a',
          memoryResourceId: 'workspace-a',
          modelSettings: undefined,
          permissionEnforceable: true,
          planModeAvailable: false,
          providerOptions: undefined,
          requestData: baseRequestData,
          resolvedModelName: 'gpt-5.2',
          selectedMemoryThreadId: 'thread-a',
          selectedProvider: 'openai',
        })
      );

      const prepared = await act(async () => result.current.prepareRequestData());

      expect('permissionPolicyRequest' in prepared).toBe(true);
      expect(prepared['permissionPolicyRequest']).toBeUndefined();
      // planModeAvailable=false above, so this is the off posture for planMode.
      expect('planMode' in prepared).toBe(true);
      expect(prepared['planMode']).toBeUndefined();

      // Assert the serialized payload directly rather than round-tripping it:
      // this is the wire boundary, not a deep clone, and `structuredClone`
      // would KEEP both undefined-valued keys.
      const wirePayload = JSON.stringify(prepared);

      expect(wirePayload).not.toContain('"permissionPolicyRequest"');
      expect(wirePayload).not.toContain('"planMode"');
    });
  });
});
