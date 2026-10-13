import type { RuntimeModelSettings } from '@brainstrike/assistant-contract';
import type { AssistantProviderSettings } from '@brainstrike/types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  type AssistantMemoryThread,
  type AssistantThreadMetadata,
  type AssistantThreadRepository,
  assertBulkThreadMetadataPatch,
} from './assistant-memory-repository';
import { resolveAssistantMemoryResourceId } from './assistant-memory-resource';
import {
  omitRecordKey,
  omitRecordKeys,
  restoreThreadCatalog,
  serializeThread,
} from './assistant-thread-catalog';
import { mergeAssistantThreadMetadata } from './assistant-thread-metadata-merge';

type AssistantThreadModelSettings = RuntimeModelSettings;

type AssistantThreadProviderOptions = Record<string, unknown>;

type AssistantThreadLoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly error: string; readonly status: 'error' };

interface AssistantThreadState {
  activeThreadIdByResourceId: Record<string, string>;
  closeAllThreadTabs: (resourceId: string) => void;
  closeOtherThreadTabs: (resourceId: string, threadId: string) => void;
  closeThreadTab: (resourceId: string, threadId: string) => void;
  closeThreadTabsToRight: (resourceId: string, threadId: string) => void;
  createThread: (
    repository: Pick<AssistantThreadRepository, 'createThread'>,
    resourceId: string,
    title?: string
  ) => Promise<AssistantMemoryThread>;
  deleteThread: (
    repository: AssistantThreadRepository,
    resourceId: string,
    threadId: string
  ) => Promise<void>;
  deleteThreads: (
    repository: AssistantThreadRepository,
    resourceId: string,
    threadIds: readonly string[]
  ) => Promise<void>;
  draftRuntimeByThreadId: Record<string, AssistantThreadDraftRuntime>;
  ensureResourceThreads: (
    repository: AssistantThreadRepository,
    resourceId: string
  ) => Promise<void>;
  lastViewedAtByThreadId: Record<string, number>;
  loadStateByResourceId: Record<string, AssistantThreadLoadState>;
  markThreadViewed: (threadId: string, viewedAt?: number) => void;
  openThreadIdsByResourceId: Record<string, string[]>;
  openThreadTab: (resourceId: string, threadId: string) => void;
  refreshResourceThreads: (
    repository: AssistantThreadRepository,
    resourceId: string
  ) => Promise<void>;
  renameThread: (
    repository: AssistantThreadRepository,
    resourceId: string,
    threadId: string,
    title: string
  ) => Promise<void>;
  reorderThreadTabs: (resourceId: string, orderedThreadIds: readonly string[]) => void;
  selectedThreadByResourceId: Record<string, string>;
  selectThread: (resourceId: string, threadId: string) => void;
  setThreadDraftRuntime: (threadId: string, config: AssistantThreadDraftRuntime) => void;
  threadIdsByResourceId: Record<string, string[]>;
  threadsByResourceId: Record<string, AssistantMemoryThread[]>;
  unavailableSavedThreadByResourceId: Record<string, string>;
  /**
   * Epoch ms below which NOTHING is unseen — stamped once, when this store
   * first exists for a user (fresh install) or when their v3 blob is migrated.
   *
   * Without it, an empty `lastViewedAtByThreadId` reads as "the user has never
   * seen anything", so every thread whose latest run ever completed would carry
   * the done-unseen dot on first launch — a storm on the very signal that is
   * supposed to mean "this finished while you were away". The v3 blob carries
   * no thread ids and no run timestamps, so per-thread watermarks cannot be
   * seeded from it; this one number is the honest floor instead. It is only
   * ever raised (creation, migrate, reset) — never lowered, and never inferred
   * from a run.
   */
  unseenBaselineAt: number;
  updateThreadMetadata: (
    repository: AssistantThreadRepository,
    resourceId: string,
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  updateThreadsMetadata: (
    repository: AssistantThreadRepository,
    resourceId: string,
    threadIds: readonly string[],
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
}

export interface AssistantThreadDraftRuntime {
  readonly model?: string;
  readonly modelSettings?: AssistantThreadModelSettings;
  readonly provider?: string;
  readonly providerOptions?: AssistantThreadProviderOptions;
  readonly providerSettings?: Record<string, AssistantProviderSettings>;
  readonly runtimeKind?: 'browser' | 'gateway' | 'hosted' | 'local';
}

type PersistedAssistantThreadState = Pick<
  AssistantThreadState,
  | 'activeThreadIdByResourceId'
  | 'draftRuntimeByThreadId'
  | 'lastViewedAtByThreadId'
  | 'openThreadIdsByResourceId'
  | 'selectedThreadByResourceId'
  | 'unseenBaselineAt'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Version 4 introduced the per-thread viewed watermark
 * (`lastViewedAtByThreadId`) and the `unseenBaselineAt` floor beneath it.
 * This migrate only knows how to bridge a version-3 blob into version 4 by
 * filling those two keys — every other field is passed through UNVALIDATED
 * (deliberately: the persisted threads state has never been validated on
 * load, and starting to repair it here would silently rewrite a user's open
 * tabs). Any other version — including one older than 3 (an unrecorded shape
 * this migrate was never written against) or one newer than 4 (a downgrade,
 * where hydrating would silently accept fields this build doesn't know about)
 * — is unsupported and must throw rather than be hydrated verbatim.
 */
export function migrateAssistantThreadPersistedState(
  persistedState: unknown,
  version: number
): PersistedAssistantThreadState {
  if (version !== 3) {
    throw new Error(`Unsupported persisted assistant thread state version: ${version}.`);
  }
  if (!isRecord(persistedState)) {
    throw new Error('Invalid persisted assistant thread state.');
  }
  // Deliberately unvalidated below this point: only the top-level shape (a
  // record) is checked. The inner fields (activeThreadIdByResourceId, etc.)
  // are passed through as-is, matching the load path, which has never
  // validated them either.
  // The upgrade moment IS the baseline: an upgrading user's existing threads
  // were all "seen" before this build shipped, and only runs completing after
  // this point can be news to them.
  const migrated: Record<string, unknown> = {
    ...persistedState,
    lastViewedAtByThreadId: {},
    unseenBaselineAt: Date.now(),
  };
  return migrated as PersistedAssistantThreadState;
}

const resourceThreadLoadPromises = new Map<string, Promise<void>>();
let resourceThreadLoadGeneration = 0;
const resourceThreadRefreshStateByResourceId = new Map<
  string,
  { applied: number; started: number }
>();

function mergeThread(
  currentThreads: readonly AssistantMemoryThread[],
  thread: AssistantMemoryThread
): AssistantMemoryThread[] {
  const nextThreads = [thread, ...currentThreads.filter((item) => item.id !== thread.id)];
  return nextThreads.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
}

function selectExistingThread(
  currentSelectedThreadId: string | undefined,
  threads: readonly AssistantMemoryThread[]
): string | undefined {
  if (currentSelectedThreadId && threads.some((thread) => thread.id === currentSelectedThreadId)) {
    return currentSelectedThreadId;
  }
  return threads[0]?.id;
}

function openThreadIds(
  currentOpenThreadIds: readonly string[] | undefined,
  threadId: string
): string[] {
  if (!currentOpenThreadIds) {
    return [threadId];
  }
  if (currentOpenThreadIds.includes(threadId)) {
    return [...currentOpenThreadIds];
  }
  return [...currentOpenThreadIds, threadId];
}

function reconcileOpenThreadIds(
  currentOpenThreadIds: readonly string[] | undefined,
  loadedThreadIds: ReadonlySet<string>,
  selectedThreadId: string | undefined
): string[] {
  const openIds = (currentOpenThreadIds ?? []).filter((threadId) => loadedThreadIds.has(threadId));
  if (selectedThreadId && !openIds.includes(selectedThreadId)) {
    openIds.push(selectedThreadId);
  }
  return openIds;
}

function assertExactOpenThreadOrder(
  currentOpenThreadIds: readonly string[],
  orderedThreadIds: readonly string[]
): void {
  const orderedIdSet = new Set(orderedThreadIds);
  const containsEveryOpenThread = currentOpenThreadIds.every((threadId) =>
    orderedIdSet.has(threadId)
  );
  if (
    orderedThreadIds.length !== currentOpenThreadIds.length ||
    orderedIdSet.size !== currentOpenThreadIds.length ||
    !containsEveryOpenThread
  ) {
    throw new Error('Assistant thread tab order must contain every open thread exactly once.');
  }
}

function hasSameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((threadId, index) => threadId === right[index]);
}

function selectActiveThreadAfterClose(
  currentOpenThreadIds: readonly string[],
  closingThreadId: string
): string | undefined {
  const closingIndex = currentOpenThreadIds.indexOf(closingThreadId);
  const remainingThreadIds = currentOpenThreadIds.filter(
    (threadId) => threadId !== closingThreadId
  );
  if (remainingThreadIds.length === 0) {
    return;
  }
  return remainingThreadIds[closingIndex] ?? remainingThreadIds.at(-1);
}

function requireThreadIdBatch(threadIds: readonly string[]): readonly string[] {
  if (!Array.isArray(threadIds) || threadIds.length === 0) {
    throw new Error('At least one assistant thread id is required.');
  }
  const seenIds = new Set<string>();
  for (const threadId of threadIds) {
    if (typeof threadId !== 'string' || !threadId.trim()) {
      throw new Error('Assistant thread id is required.');
    }
    if (seenIds.has(threadId)) {
      throw new Error(`Duplicate assistant thread id: ${threadId}.`);
    }
    seenIds.add(threadId);
  }
  return threadIds;
}

function requireLoadedThreads(
  loadedThreads: readonly AssistantMemoryThread[],
  threadIds: readonly string[]
): void {
  const loadedThreadIds = new Set(loadedThreads.map((thread) => thread.id));
  for (const threadId of threadIds) {
    if (!loadedThreadIds.has(threadId)) {
      throw new Error(`Unknown assistant thread: ${threadId}.`);
    }
  }
}

function requireBulkDelete(
  repository: AssistantThreadRepository
): NonNullable<AssistantThreadRepository['deleteThreads']> {
  if (!repository.deleteThreads) {
    throw new Error('Assistant thread repository does not support atomic bulk deletion.');
  }
  return repository.deleteThreads;
}

function requireBulkMetadataUpdate(
  repository: AssistantThreadRepository
): NonNullable<AssistantThreadRepository['updateThreadsMetadata']> {
  if (!repository.updateThreadsMetadata) {
    throw new Error('Assistant thread repository does not support atomic bulk metadata updates.');
  }
  return repository.updateThreadsMetadata;
}

function selectActiveThreadAfterDelete({
  currentOpenThreadIds,
  deletedThreadId,
  remainingThreadIds,
}: {
  currentOpenThreadIds: readonly string[];
  deletedThreadId: string;
  remainingThreadIds: readonly string[];
}): string | undefined {
  const nextOpenActive = selectActiveThreadAfterClose(currentOpenThreadIds, deletedThreadId);
  if (nextOpenActive) {
    return nextOpenActive;
  }
  return remainingThreadIds[0];
}

function selectActiveThreadAfterBulkDelete({
  currentActiveThreadId,
  currentOpenThreadIds,
  deletedThreadIds,
  remainingThreadIds,
}: {
  currentActiveThreadId: string | undefined;
  currentOpenThreadIds: readonly string[];
  deletedThreadIds: ReadonlySet<string>;
  remainingThreadIds: readonly string[];
}): string | undefined {
  if (currentActiveThreadId && !deletedThreadIds.has(currentActiveThreadId)) {
    return currentActiveThreadId;
  }
  const activeIndex = currentActiveThreadId
    ? currentOpenThreadIds.indexOf(currentActiveThreadId)
    : -1;
  const remainingOpenThreadIds = currentOpenThreadIds.filter(
    (threadId) => !deletedThreadIds.has(threadId)
  );
  if (activeIndex >= 0) {
    const nextOpenThread = currentOpenThreadIds
      .slice(activeIndex + 1)
      .find((threadId) => !deletedThreadIds.has(threadId));
    if (nextOpenThread) {
      return nextOpenThread;
    }
  }
  return remainingOpenThreadIds.at(-1) ?? remainingThreadIds[0];
}

function copyProviderSettings(
  providerSettings: Record<string, AssistantProviderSettings> | undefined
): Record<string, AssistantProviderSettings> | undefined {
  if (!providerSettings) {
    return;
  }
  return Object.fromEntries(
    Object.entries(providerSettings).map(([providerId, settings]) => [providerId, { ...settings }])
  );
}

function normalizeDraftRuntime(config: AssistantThreadDraftRuntime): AssistantThreadDraftRuntime {
  const providerSettings = copyProviderSettings(config.providerSettings);
  return {
    ...config,
    ...(config.modelSettings ? { modelSettings: { ...config.modelSettings } } : {}),
    ...(config.providerOptions ? { providerOptions: { ...config.providerOptions } } : {}),
    ...(providerSettings ? { providerSettings } : {}),
  };
}

async function loadResourceThreadsForGeneration(
  repository: AssistantThreadRepository,
  resourceId: string,
  loadGeneration: number
): Promise<AssistantMemoryThread[] | null> {
  const loadedThreads = (await repository.listThreads(resourceId)).map(serializeThread);
  if (loadGeneration !== resourceThreadLoadGeneration) {
    return null;
  }
  useAssistantThreadStore.setState((state) =>
    restoreThreadCatalog(state, resourceId, loadedThreads)
  );
  const threads =
    loadedThreads.length > 0
      ? loadedThreads
      : [serializeThread(await repository.createThread(resourceId))];
  return loadGeneration === resourceThreadLoadGeneration ? threads : null;
}

function recordResourceThreadLoadError(
  resourceId: string,
  loadGeneration: number,
  error: unknown
): void {
  if (loadGeneration !== resourceThreadLoadGeneration) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  useAssistantThreadStore.setState((state) => ({
    loadStateByResourceId: {
      ...state.loadStateByResourceId,
      [resourceId]: { error: message, status: 'error' },
    },
  }));
}

function releaseResourceThreadLoad(resourceId: string, loadGeneration: number): void {
  if (loadGeneration === resourceThreadLoadGeneration) {
    resourceThreadLoadPromises.delete(resourceId);
  }
}

export const useAssistantThreadStore = create<AssistantThreadState>()(
  persist(
    (set, get) => ({
      activeThreadIdByResourceId: {},
      closeAllThreadTabs: (resourceId: string) => {
        const state = get();
        const openThreadIds = state.openThreadIdsByResourceId[resourceId] ?? [];
        const hasActiveThread = resourceId in state.activeThreadIdByResourceId;
        const hasSelectedThread = resourceId in state.selectedThreadByResourceId;
        if (openThreadIds.length === 0 && !(hasActiveThread || hasSelectedThread)) {
          return;
        }
        set({
          activeThreadIdByResourceId: omitRecordKey(state.activeThreadIdByResourceId, resourceId),
          openThreadIdsByResourceId: {
            ...state.openThreadIdsByResourceId,
            [resourceId]: [],
          },
          selectedThreadByResourceId: omitRecordKey(state.selectedThreadByResourceId, resourceId),
        });
      },
      closeOtherThreadTabs: (resourceId: string, threadId: string) => {
        const state = get();
        const openThreadIds = state.openThreadIdsByResourceId[resourceId] ?? [];
        if (!openThreadIds.includes(threadId)) {
          return;
        }
        if (
          openThreadIds.length === 1 &&
          state.activeThreadIdByResourceId[resourceId] === threadId &&
          state.selectedThreadByResourceId[resourceId] === threadId
        ) {
          return;
        }
        set({
          activeThreadIdByResourceId: {
            ...state.activeThreadIdByResourceId,
            [resourceId]: threadId,
          },
          openThreadIdsByResourceId: {
            ...state.openThreadIdsByResourceId,
            [resourceId]: [threadId],
          },
          selectedThreadByResourceId: {
            ...state.selectedThreadByResourceId,
            [resourceId]: threadId,
          },
        });
      },
      closeThreadTab: (resourceId: string, threadId: string) => {
        set((state) => {
          const currentOpenThreadIds = state.openThreadIdsByResourceId[resourceId] ?? [];
          const nextOpenThreadIds = currentOpenThreadIds.filter((item) => item !== threadId);
          const wasActive = state.activeThreadIdByResourceId[resourceId] === threadId;
          const nextActiveThreadId = wasActive
            ? selectActiveThreadAfterClose(currentOpenThreadIds, threadId)
            : state.activeThreadIdByResourceId[resourceId];

          return {
            activeThreadIdByResourceId: nextActiveThreadId
              ? {
                  ...state.activeThreadIdByResourceId,
                  [resourceId]: nextActiveThreadId,
                }
              : omitRecordKey(state.activeThreadIdByResourceId, resourceId),
            openThreadIdsByResourceId: {
              ...state.openThreadIdsByResourceId,
              [resourceId]: nextOpenThreadIds,
            },
            selectedThreadByResourceId: nextActiveThreadId
              ? {
                  ...state.selectedThreadByResourceId,
                  [resourceId]: nextActiveThreadId,
                }
              : omitRecordKey(state.selectedThreadByResourceId, resourceId),
          };
        });
      },
      closeThreadTabsToRight: (resourceId: string, threadId: string) => {
        const state = get();
        const openThreadIds = state.openThreadIdsByResourceId[resourceId] ?? [];
        const targetIndex = openThreadIds.indexOf(threadId);
        if (targetIndex === -1) {
          return;
        }
        const remainingThreadIds = openThreadIds.slice(0, targetIndex + 1);
        const currentActiveThreadId = state.activeThreadIdByResourceId[resourceId];
        const nextActiveThreadId =
          currentActiveThreadId && remainingThreadIds.includes(currentActiveThreadId)
            ? currentActiveThreadId
            : threadId;
        if (
          remainingThreadIds.length === openThreadIds.length &&
          currentActiveThreadId === nextActiveThreadId &&
          state.selectedThreadByResourceId[resourceId] === nextActiveThreadId
        ) {
          return;
        }
        set({
          activeThreadIdByResourceId: {
            ...state.activeThreadIdByResourceId,
            [resourceId]: nextActiveThreadId,
          },
          openThreadIdsByResourceId: {
            ...state.openThreadIdsByResourceId,
            [resourceId]: remainingThreadIds,
          },
          selectedThreadByResourceId: {
            ...state.selectedThreadByResourceId,
            [resourceId]: nextActiveThreadId,
          },
        });
      },
      createThread: async (
        repository: Pick<AssistantThreadRepository, 'createThread'>,
        resourceId: string,
        title?: string
      ) => {
        const initialLoad = resourceThreadLoadPromises.get(resourceId);
        if (initialLoad) {
          await initialLoad;
        }
        set((state) => ({
          loadStateByResourceId: {
            ...state.loadStateByResourceId,
            [resourceId]: { status: 'loading' },
          },
        }));
        try {
          const thread = serializeThread(await repository.createThread(resourceId, title));
          set((state) => {
            const threads = mergeThread(state.threadsByResourceId[resourceId] ?? [], thread);
            return {
              activeThreadIdByResourceId: {
                ...state.activeThreadIdByResourceId,
                [resourceId]: thread.id,
              },
              loadStateByResourceId: {
                ...state.loadStateByResourceId,
                [resourceId]: { status: 'ready' },
              },
              openThreadIdsByResourceId: {
                ...state.openThreadIdsByResourceId,
                [resourceId]: openThreadIds(state.openThreadIdsByResourceId[resourceId], thread.id),
              },
              selectedThreadByResourceId: {
                ...state.selectedThreadByResourceId,
                [resourceId]: thread.id,
              },
              threadIdsByResourceId: {
                ...state.threadIdsByResourceId,
                [resourceId]: threads.map((item) => item.id),
              },
              threadsByResourceId: {
                ...state.threadsByResourceId,
                [resourceId]: threads,
              },
              unavailableSavedThreadByResourceId: omitRecordKey(
                state.unavailableSavedThreadByResourceId,
                resourceId
              ),
            };
          });
          return thread;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((state) => ({
            loadStateByResourceId: {
              ...state.loadStateByResourceId,
              [resourceId]: { error: message, status: 'error' },
            },
          }));
          throw error;
        }
      },
      deleteThread: async (
        repository: AssistantThreadRepository,
        resourceId: string,
        threadId: string
      ): Promise<void> => {
        await repository.deleteThread(threadId);
        set((state) => {
          const remainingThreads = (state.threadsByResourceId[resourceId] ?? []).filter(
            (thread) => thread.id !== threadId
          );
          const remainingThreadIds = remainingThreads.map((thread) => thread.id);
          const currentOpenThreadIds = state.openThreadIdsByResourceId[resourceId] ?? [];
          const nextOpenThreadIds = currentOpenThreadIds.filter((item) => item !== threadId);
          const nextActiveThreadId = selectActiveThreadAfterDelete({
            currentOpenThreadIds,
            deletedThreadId: threadId,
            remainingThreadIds,
          });

          return {
            activeThreadIdByResourceId: nextActiveThreadId
              ? {
                  ...state.activeThreadIdByResourceId,
                  [resourceId]: nextActiveThreadId,
                }
              : omitRecordKey(state.activeThreadIdByResourceId, resourceId),
            draftRuntimeByThreadId: omitRecordKey(state.draftRuntimeByThreadId, threadId),
            lastViewedAtByThreadId: omitRecordKey(state.lastViewedAtByThreadId, threadId),
            loadStateByResourceId: {
              ...state.loadStateByResourceId,
              [resourceId]: { status: 'ready' },
            },
            openThreadIdsByResourceId: {
              ...state.openThreadIdsByResourceId,
              [resourceId]: nextOpenThreadIds,
            },
            selectedThreadByResourceId: nextActiveThreadId
              ? {
                  ...state.selectedThreadByResourceId,
                  [resourceId]: nextActiveThreadId,
                }
              : omitRecordKey(state.selectedThreadByResourceId, resourceId),
            threadIdsByResourceId: {
              ...state.threadIdsByResourceId,
              [resourceId]: remainingThreadIds,
            },
            threadsByResourceId: {
              ...state.threadsByResourceId,
              [resourceId]: remainingThreads,
            },
          };
        });
      },
      deleteThreads: async (
        repository: AssistantThreadRepository,
        resourceId: string,
        threadIds: readonly string[]
      ): Promise<void> => {
        requireThreadIdBatch(threadIds);
        const loadedThreads = get().threadsByResourceId[resourceId] ?? [];
        requireLoadedThreads(loadedThreads, threadIds);
        await requireBulkDelete(repository)(threadIds);
        const deletedThreadIds = new Set(threadIds);
        set((state) => {
          const remainingThreads = (state.threadsByResourceId[resourceId] ?? []).filter(
            (thread) => !deletedThreadIds.has(thread.id)
          );
          const remainingThreadIds = remainingThreads.map((thread) => thread.id);
          const currentOpenThreadIds = state.openThreadIdsByResourceId[resourceId] ?? [];
          const nextOpenThreadIds = currentOpenThreadIds.filter(
            (threadId) => !deletedThreadIds.has(threadId)
          );
          const nextActiveThreadId = selectActiveThreadAfterBulkDelete({
            currentActiveThreadId:
              state.activeThreadIdByResourceId[resourceId] ??
              state.selectedThreadByResourceId[resourceId],
            currentOpenThreadIds,
            deletedThreadIds,
            remainingThreadIds,
          });
          return {
            activeThreadIdByResourceId: nextActiveThreadId
              ? { ...state.activeThreadIdByResourceId, [resourceId]: nextActiveThreadId }
              : omitRecordKey(state.activeThreadIdByResourceId, resourceId),
            draftRuntimeByThreadId: omitRecordKeys(state.draftRuntimeByThreadId, deletedThreadIds),
            lastViewedAtByThreadId: omitRecordKeys(state.lastViewedAtByThreadId, deletedThreadIds),
            loadStateByResourceId: {
              ...state.loadStateByResourceId,
              [resourceId]: { status: 'ready' },
            },
            openThreadIdsByResourceId: {
              ...state.openThreadIdsByResourceId,
              [resourceId]: nextOpenThreadIds,
            },
            selectedThreadByResourceId: nextActiveThreadId
              ? { ...state.selectedThreadByResourceId, [resourceId]: nextActiveThreadId }
              : omitRecordKey(state.selectedThreadByResourceId, resourceId),
            threadIdsByResourceId: {
              ...state.threadIdsByResourceId,
              [resourceId]: remainingThreadIds,
            },
            threadsByResourceId: {
              ...state.threadsByResourceId,
              [resourceId]: remainingThreads,
            },
          };
        });
      },
      draftRuntimeByThreadId: {},
      ensureResourceThreads: async (
        repository: AssistantThreadRepository,
        resourceId: string
      ): Promise<void> => {
        const existingLoad = resourceThreadLoadPromises.get(resourceId);
        if (existingLoad) {
          return existingLoad;
        }
        const currentLoadStatus = get().loadStateByResourceId[resourceId]?.status;
        if (currentLoadStatus === 'ready' || currentLoadStatus === 'loading') {
          return;
        }

        const loadGeneration = resourceThreadLoadGeneration;
        const loadPromise = (async () => {
          set((state) => ({
            loadStateByResourceId: {
              ...state.loadStateByResourceId,
              [resourceId]: { status: 'loading' },
            },
          }));

          try {
            const threads = await loadResourceThreadsForGeneration(
              repository,
              resourceId,
              loadGeneration
            );
            if (!threads) {
              return;
            }
            const selectedThreadId = selectExistingThread(
              get().activeThreadIdByResourceId[resourceId] ??
                get().selectedThreadByResourceId[resourceId],
              threads
            );
            const loadedThreadIds = new Set(threads.map((thread) => thread.id));

            set((state) => ({
              activeThreadIdByResourceId: selectedThreadId
                ? {
                    ...state.activeThreadIdByResourceId,
                    [resourceId]: selectedThreadId,
                  }
                : state.activeThreadIdByResourceId,
              loadStateByResourceId: {
                ...state.loadStateByResourceId,
                [resourceId]: { status: 'ready' },
              },
              openThreadIdsByResourceId: {
                ...state.openThreadIdsByResourceId,
                [resourceId]: reconcileOpenThreadIds(
                  state.openThreadIdsByResourceId[resourceId],
                  loadedThreadIds,
                  selectedThreadId
                ),
              },
              selectedThreadByResourceId: selectedThreadId
                ? {
                    ...state.selectedThreadByResourceId,
                    [resourceId]: selectedThreadId,
                  }
                : state.selectedThreadByResourceId,
              threadIdsByResourceId: {
                ...state.threadIdsByResourceId,
                [resourceId]: threads.map((thread) => thread.id),
              },
              threadsByResourceId: {
                ...state.threadsByResourceId,
                [resourceId]: threads,
              },
            }));
          } catch (error) {
            recordResourceThreadLoadError(resourceId, loadGeneration, error);
            throw error;
          } finally {
            releaseResourceThreadLoad(resourceId, loadGeneration);
          }
        })();

        resourceThreadLoadPromises.set(resourceId, loadPromise);
        return loadPromise;
      },
      lastViewedAtByThreadId: {},
      loadStateByResourceId: {},
      markThreadViewed: (threadId: string, viewedAt?: number): void => {
        if (!threadId.trim()) {
          throw new Error('Thread id is required.');
        }
        const nextViewedAt = viewedAt ?? Date.now();
        // Idempotent and monotonic: a later read of an older run must never
        // resurrect an unseen badge the user already cleared.
        const currentViewedAt = get().lastViewedAtByThreadId[threadId];
        if (currentViewedAt !== undefined && currentViewedAt >= nextViewedAt) {
          return;
        }
        set((state) => ({
          lastViewedAtByThreadId: {
            ...state.lastViewedAtByThreadId,
            [threadId]: nextViewedAt,
          },
        }));
      },
      openThreadIdsByResourceId: {},
      openThreadTab: (resourceId: string, threadId: string) => {
        set((state) => ({
          activeThreadIdByResourceId: {
            ...state.activeThreadIdByResourceId,
            [resourceId]: threadId,
          },
          openThreadIdsByResourceId: {
            ...state.openThreadIdsByResourceId,
            [resourceId]: openThreadIds(state.openThreadIdsByResourceId[resourceId], threadId),
          },
          selectedThreadByResourceId: {
            ...state.selectedThreadByResourceId,
            [resourceId]: threadId,
          },
          unavailableSavedThreadByResourceId: omitRecordKey(
            state.unavailableSavedThreadByResourceId,
            resourceId
          ),
        }));
      },
      refreshResourceThreads: async (
        repository: AssistantThreadRepository,
        resourceId: string
      ): Promise<void> => {
        // Re-list already-loaded threads so titles set out-of-band (the
        // observational-memory thread-title extractor names threads as a run's
        // observations run) become visible. Only refreshes a resource that has
        // finished its initial load — ensureResourceThreads owns first load and
        // the empty-resource default-thread seed. Selection/open state is keyed
        // by id, which the merge preserves, so it is untouched here. Concurrent
        // refreshes apply in latest-successful-start order per resource: empty or
        // failed newer reads do not suppress an older successful read.
        if (get().loadStateByResourceId[resourceId]?.status !== 'ready') {
          return;
        }
        const refreshState = resourceThreadRefreshStateByResourceId.get(resourceId) ?? {
          applied: 0,
          started: 0,
        };
        refreshState.started += 1;
        const refreshGeneration = refreshState.started;
        resourceThreadRefreshStateByResourceId.set(resourceId, refreshState);
        const metadataSnapshotByThreadId = new Map(
          (get().threadsByResourceId[resourceId] ?? []).map((thread) => [
            thread.id,
            thread.metadata,
          ])
        );
        const loaded = (await repository.listThreads(resourceId)).map(serializeThread);
        if (loaded.length === 0) {
          return;
        }
        const currentRefreshState = resourceThreadRefreshStateByResourceId.get(resourceId);
        if (currentRefreshState !== refreshState || refreshGeneration < refreshState.applied) {
          return;
        }
        refreshState.applied = refreshGeneration;
        set((state) => {
          const currentThreadById = new Map(
            (state.threadsByResourceId[resourceId] ?? []).map((thread) => [thread.id, thread])
          );
          const refreshedThreads = loaded.map((thread) => {
            const currentThread = currentThreadById.get(thread.id);
            if (
              !currentThread ||
              currentThread.metadata === metadataSnapshotByThreadId.get(thread.id) ||
              currentThread.metadata === undefined
            ) {
              return thread;
            }
            return { ...thread, metadata: currentThread.metadata };
          });
          return {
            threadIdsByResourceId: {
              ...state.threadIdsByResourceId,
              [resourceId]: refreshedThreads.map((thread) => thread.id),
            },
            threadsByResourceId: {
              ...state.threadsByResourceId,
              [resourceId]: refreshedThreads,
            },
          };
        });
      },
      renameThread: async (
        repository: AssistantThreadRepository,
        resourceId: string,
        threadId: string,
        title: string
      ): Promise<void> => {
        const normalizedTitle = title.trim();
        await repository.renameThread(threadId, normalizedTitle);
        set((state) => ({
          threadsByResourceId: {
            ...state.threadsByResourceId,
            [resourceId]: (state.threadsByResourceId[resourceId] ?? []).map((thread) =>
              thread.id === threadId
                ? { ...thread, title: normalizedTitle, updatedAt: new Date() }
                : thread
            ),
          },
        }));
      },
      reorderThreadTabs: (resourceId: string, orderedThreadIds: readonly string[]) => {
        set((state) => {
          const currentOpenThreadIds = state.openThreadIdsByResourceId[resourceId] ?? [];
          assertExactOpenThreadOrder(currentOpenThreadIds, orderedThreadIds);
          if (hasSameOrder(currentOpenThreadIds, orderedThreadIds)) {
            return state;
          }
          return {
            openThreadIdsByResourceId: {
              ...state.openThreadIdsByResourceId,
              [resourceId]: [...orderedThreadIds],
            },
          };
        });
      },
      selectedThreadByResourceId: {},
      selectThread: (resourceId: string, threadId: string) => {
        get().openThreadTab(resourceId, threadId);
      },
      setThreadDraftRuntime: (threadId: string, config: AssistantThreadDraftRuntime) => {
        set((state) => ({
          draftRuntimeByThreadId: {
            ...state.draftRuntimeByThreadId,
            [threadId]: normalizeDraftRuntime(config),
          },
        }));
      },
      threadIdsByResourceId: {},
      threadsByResourceId: {},
      unavailableSavedThreadByResourceId: {},
      unseenBaselineAt: Date.now(),
      updateThreadMetadata: async (
        repository: AssistantThreadRepository,
        resourceId: string,
        threadId: string,
        metadata: AssistantThreadMetadata
      ): Promise<void> => {
        await repository.updateThreadMetadata(threadId, metadata);
        set((state) => ({
          threadsByResourceId: {
            ...state.threadsByResourceId,
            [resourceId]: (state.threadsByResourceId[resourceId] ?? []).map((thread) =>
              thread.id === threadId
                ? {
                    ...thread,
                    metadata: mergeAssistantThreadMetadata(thread.metadata, metadata),
                  }
                : thread
            ),
          },
        }));
      },
      updateThreadsMetadata: async (
        repository: AssistantThreadRepository,
        resourceId: string,
        threadIds: readonly string[],
        metadata: AssistantThreadMetadata
      ): Promise<void> => {
        requireThreadIdBatch(threadIds);
        // Fail fast, before the load/repository round-trip: the repository
        // rejects this too, but attributing it here names the reason (checkout
        // state is a single-thread, atomic write) without wasting the trip.
        assertBulkThreadMetadataPatch(metadata);
        const loadedThreads = get().threadsByResourceId[resourceId] ?? [];
        requireLoadedThreads(loadedThreads, threadIds);
        await requireBulkMetadataUpdate(repository)(threadIds, metadata);
        const updatedThreadIds = new Set(threadIds);
        set((state) => ({
          threadsByResourceId: {
            ...state.threadsByResourceId,
            [resourceId]: (state.threadsByResourceId[resourceId] ?? []).map((thread) =>
              updatedThreadIds.has(thread.id)
                ? {
                    ...thread,
                    metadata: mergeAssistantThreadMetadata(thread.metadata, metadata),
                  }
                : thread
            ),
          },
        }));
      },
    }),
    {
      migrate: migrateAssistantThreadPersistedState,
      name: 'brainstrike-assistant-threads-v1',
      partialize: (state): PersistedAssistantThreadState => ({
        activeThreadIdByResourceId: state.activeThreadIdByResourceId,
        draftRuntimeByThreadId: state.draftRuntimeByThreadId,
        lastViewedAtByThreadId: state.lastViewedAtByThreadId,
        openThreadIdsByResourceId: state.openThreadIdsByResourceId,
        selectedThreadByResourceId: state.selectedThreadByResourceId,
        unseenBaselineAt: state.unseenBaselineAt,
      }),
      version: 4,
    }
  )
);

/**
 * The ACTIVE thread id for the workspace resource — the single "which thread
 * is the user looking at" signal (BST-1268 unification). Canvas, Changes, and
 * the thread-workspace coordinator all key off THIS selector; the
 * changes-navigation store's `activeThreadIdentity` carries only run-tracking
 * facts (`latestRunId`) for the same thread, published by the ACTIVE
 * wrapper's run stream.
 */
export function useActiveAssistantThreadId(resourceIdOverride?: string): string | null {
  const resourceId = resolveAssistantMemoryResourceId(resourceIdOverride);
  return useAssistantThreadStore((state) => state.activeThreadIdByResourceId[resourceId] ?? null);
}

export function resetAssistantThreadStore(): void {
  resourceThreadLoadGeneration += 1;
  resourceThreadLoadPromises.clear();
  resourceThreadRefreshStateByResourceId.clear();
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: {},
    draftRuntimeByThreadId: {},
    lastViewedAtByThreadId: {},
    loadStateByResourceId: {},
    openThreadIdsByResourceId: {},
    selectedThreadByResourceId: {},
    threadIdsByResourceId: {},
    threadsByResourceId: {},
    unavailableSavedThreadByResourceId: {},
    // Re-stamped, not zeroed: a reset clears every watermark, so a zero floor
    // would make every surviving run's completion read as news.
    unseenBaselineAt: Date.now(),
  });
}
