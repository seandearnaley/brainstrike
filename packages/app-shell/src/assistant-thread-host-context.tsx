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
  /** The run is waiting on its user: an approval, question or plan is unanswered. */
  readonly needsInput: boolean;
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
  /** Commits an owned thread's title through the host; it never reaches history. */
  renameThread(threadId: string, title: string): Promise<void>;
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
  /** Called when a host thread's committed title changes; a host without live titles omits it. */
  subscribeTitleChanges?(listener: () => void): () => void;
  /**
   * Commits an owned thread's workspace binding keys through the host. Any key
   * the host does not own rejects before a request, never reaching history.
   */
  updateThreadBinding(threadId: string, metadata: AssistantThreadMetadata): Promise<void>;
  workspaceRepository(history: ThreadWorkspaceRepository): ThreadWorkspaceRepository;
}
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

export const LEGACY_READ_ONLY_MESSAGE =
  'This conversation was started before the agent host and is read-only; it cannot be renamed or changed.';

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
  // A legacy (non-host) thread is read-only (BST-1934): its title and metadata
  // are refused visibly and never written to the legacy tables.
  const updateThreadMetadata = async (
    threadId: string,
    metadata: AssistantThreadMetadata
  ): Promise<void> => {
    if (!(await host.ownsThread(threadId))) {
      throw new Error(LEGACY_READ_ONLY_MESSAGE);
    }
    await host.updateThreadBinding(threadId, metadata);
  };
  // A history UPDATE would match no host row and report success, so an owned
  // title commits through the host; a refusal rejects before history.
  const renameThread = async (threadId: string, title: string): Promise<void> => {
    if (!(await host.ownsThread(threadId))) {
      throw new Error(LEGACY_READ_ONLY_MESSAGE);
    }
    await host.renameThread(threadId, title);
  };
  const updateHistoryThreadsMetadata = repository.updateThreadsMetadata?.bind(repository);
  // The bulk path stays with history: it already refuses, before any write,
  // any id without a history row (assertAllBulkThreadsFound).
  return {
    ...repository,
    createThread: (resourceId) => host.createThread(resourceId),
    deleteThread,
    renameThread,
    updateThreadMetadata,
    ...(updateHistoryThreadsMetadata
      ? {
          // Bulk stays with history, which already refuses any host id before
          // a write; a legacy id is refused here, so nothing reaches it.
          updateThreadsMetadata: async (
            threadIds: readonly string[],
            metadata: AssistantThreadMetadata
          ): Promise<void> => {
            const owned = await Promise.all(threadIds.map((id) => host.ownsThread(id)));
            if (owned.includes(false)) {
              throw new Error(LEGACY_READ_ONLY_MESSAGE);
            }
            await updateHistoryThreadsMetadata(threadIds, metadata);
          },
        }
      : {}),
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
