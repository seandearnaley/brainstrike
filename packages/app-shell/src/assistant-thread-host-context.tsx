import type {
  AssistantMemoryThread,
  AssistantThreadMetadata,
  AssistantThreadRepository,
  AssistantThreadRunStatus,
  ThreadWorkspaceRepository,
} from '@brainstrike/assistant-data';
import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';

/** A host thread's latest committed root run, read as the thread badges read a run row. */
export interface AssistantThreadHostRun {
  /** The committed finish time; null while running or when the host recorded none. */
  readonly completedAt: Date | null;
  readonly status: Exclude<AssistantThreadRunStatus, 'cancelling'>;
}

/** The host's committed run state per thread it owns, as this window observes it. */
export interface AssistantThreadHostRuns {
  readonly getSnapshot: () => ReadonlyMap<string, AssistantThreadHostRun>;
  readonly subscribe: (listener: () => void) => () => void;
}

/** A host app supplies committed thread identity and its connected presentation. */
export interface AssistantThreadHostCapability {
  createThread(resourceId: string): Promise<AssistantMemoryThread>;
  /** True only for an identity owned and physically deleted by this host. */
  deleteThread(threadId: string): Promise<boolean>;
  listThreads(resourceId: string): Promise<readonly AssistantMemoryThread[]>;
  /** True only for an identity this host owns; its metadata never reaches history. */
  ownsThread(threadId: string): Promise<boolean>;
  /**
   * `onRunningChange` reports the rendered view's own run state, so a tab
   * closed mid-run keeps its view mounted and observing (BST-1844).
   */
  renderThread(
    threadId: string,
    isVisible: boolean,
    onRunningChange?: (threadId: string, running: boolean) => void
  ): ReactNode | undefined;
  /** Omitted by a host that reports no run state; its threads then show none. */
  readonly runs?: AssistantThreadHostRuns;
  /**
   * Commits an owned thread's workspace binding keys through the host. Any key
   * the host does not own rejects before a request, never reaching history.
   */
  updateThreadBinding(threadId: string, metadata: AssistantThreadMetadata): Promise<void>;
  workspaceRepository(history: ThreadWorkspaceRepository): ThreadWorkspaceRepository;
}
const HOST_RENAME_REFUSAL = "Agent host threads can't be renamed yet; the title was not changed.";

export const AssistantThreadHostContext = createContext<AssistantThreadHostCapability | undefined>(
  undefined
);
export function useAssistantThreadHost(): AssistantThreadHostCapability | undefined {
  return useContext(AssistantThreadHostContext);
}

const NO_HOST_RUNS: ReadonlyMap<string, AssistantThreadHostRun> = new Map();
const readNoHostRuns = (): ReadonlyMap<string, AssistantThreadHostRun> => NO_HOST_RUNS;
const subscribeNoHostRuns = (): (() => void) => () => undefined;

/** The host's run state for its threads; empty where no host reports one (web). */
export function useAssistantThreadHostRuns(): ReadonlyMap<string, AssistantThreadHostRun> {
  const runs = useAssistantThreadHost()?.runs;
  const read = runs?.getSnapshot ?? readNoHostRuns;
  return useSyncExternalStore(runs?.subscribe ?? subscribeNoHostRuns, read, read);
}

/** Keep old history in its existing repository and read new roots from their actual owner. */
export function withAssistantThreadHost<Repository extends AssistantThreadRepository>(
  repository: Repository,
  host: AssistantThreadHostCapability | undefined
): Repository {
  if (!host) {
    return repository;
  }
  const deleteThread = async (threadId: string): Promise<void> => {
    if (!(await host.deleteThread(threadId))) {
      await repository.deleteThread(threadId);
    }
  };
  const deleteHistoryThreads = repository.deleteThreads?.bind(repository);
  // A host identity has no history row: a history write would update nothing
  // and report success, so a host-owned id never falls through to it.
  const updateThreadMetadata = async (
    threadId: string,
    metadata: AssistantThreadMetadata
  ): Promise<void> => {
    if (await host.ownsThread(threadId)) {
      await host.updateThreadBinding(threadId, metadata);
      return;
    }
    await repository.updateThreadMetadata(threadId, metadata);
  };
  // Interim, visible refusal: the host has no title command yet, and a history
  // UPDATE would match no row and report success while the committed title
  // stays. Refusing before the store's optimistic set keeps that title.
  const renameThread = async (threadId: string, title: string): Promise<void> => {
    if (await host.ownsThread(threadId)) {
      throw new Error(HOST_RENAME_REFUSAL);
    }
    await repository.renameThread(threadId, title);
  };
  // The bulk path stays with history: it already refuses, before any write,
  // any id without a history row (assertAllBulkThreadsFound).
  return {
    ...repository,
    createThread: (resourceId) => host.createThread(resourceId),
    deleteThread,
    renameThread,
    updateThreadMetadata,
    ...(deleteHistoryThreads
      ? {
          deleteThreads: async (threadIds: readonly string[]): Promise<void> => {
            const history: string[] = [];
            for (const threadId of threadIds) {
              if (!(await host.deleteThread(threadId))) {
                history.push(threadId);
              }
            }
            if (history.length > 0) {
              await deleteHistoryThreads(history);
            }
          },
        }
      : {}),
    listThreads: async (resourceId) => {
      const [history, current] = await Promise.all([
        repository.listThreads(resourceId),
        host.listThreads(resourceId),
      ]);
      return [...current, ...history];
    },
  };
}
