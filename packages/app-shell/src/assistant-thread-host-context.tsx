import type {
  OpenRouterModelMetadataSnapshot,
  ProviderVerificationSnapshot,
  SupportedProvider,
} from '@brainstrike/assistant-contract';
import type {
  AssistantMemoryThread,
  AssistantThreadMetadata,
  AssistantThreadRepository,
  AssistantThreadRunStatus,
  CrossRootUsageRow,
  RunLedgerRow,
  ThreadWorkspaceRepository,
} from '@brainstrike/assistant-data';
import type { HostUsageRecord } from '@brainstrike/assistant-data/cost-tracking';
import type { ThreadSearchExtraArms } from '@brainstrike/db';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';
import type { RewindPort } from './changes/rewind-port';
import { readHostChildWorkspaceTab } from './host-child-workspace-tab';
import type {
  HostThreadSearchVectors,
  ThreadSearchVectorProfile,
} from './host-thread-search-vectors';

/** The semantic arm of a host search: the query vector, its embedder identity and minimum cosine. */
export interface AssistantThreadSearchSemantic {
  readonly profile: ThreadSearchVectorProfile;
  readonly threshold: number;
  readonly vector: readonly number[];
}

/** A host thread's latest committed root run, read as the thread badges read a run row. */
export interface AssistantThreadHostRun {
  /** The committed finish time; null while running or when the host recorded none. */
  readonly completedAt: Date | null;
  /** The run is waiting on its user: an approval, question or plan is unanswered. */
  readonly needsInput: boolean;
  readonly status: Exclude<AssistantThreadRunStatus, 'cancelling'>;
}

/** Cost views' share of the host: its committed runs and provider calls. */
export interface AssistantThreadHostLedgerSnapshot {
  /** Provider calls per (root, provider, model), in the cross-root aggregation's order. */
  readonly rootUsage: readonly CrossRootUsageRow[];
  readonly runs: readonly RunLedgerRow[];
  readonly usage: readonly HostUsageRecord[];
}

export interface AssistantThreadHostLedger {
  readonly getSnapshot: () => AssistantThreadHostLedgerSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

/** The host's committed run state per thread it owns, as this window observes it. */
export interface AssistantThreadHostRuns {
  readonly getSnapshot: () => ReadonlyMap<string, AssistantThreadHostRun>;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Provider facts the host answers from its own environment and credential
 * store: availability, a credential probe and OpenRouter model metadata. A
 * client sends only ids; keys never cross.
 */
export interface AssistantHostProviders {
  readOpenRouterModel(modelId: string): Promise<OpenRouterModelMetadataSnapshot>;
  /** The availability payload; `createAssistantStatusFetcher` validates it. */
  readStatus(): Promise<unknown>;
  verifyProvider(providerId: string): Promise<ProviderVerificationSnapshot>;
}

/** One committed canvas version, in the canvas panel's read shape. */
export interface AssistantThreadHostCanvasVersion {
  readonly canvasId: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly html: string;
  readonly title: string;
  readonly version: number;
}

/** BST-1932: one child thread a host delegation started, as its origin committed it. */
export interface AssistantThreadHostChild {
  /** The child's call sign, as the host derives it ("Cedar-1a2b3c"). */
  readonly callSign: string;
  /** The child's family colour, as the host derives it from the tree. */
  readonly color: string;
  /** Delegation depth: 1 for a top-level thread's own child. */
  readonly depth: number;
  /** The parent run whose tool call started this child. */
  readonly parentRunId: string;
  /** The thread that delegated this child. */
  readonly parentThreadId: string;
  readonly persona: string;
  /** A run in progress, a run waiting on a person, or none, as the host derives it. */
  readonly status: 'working' | 'needs-input' | 'idle';
  readonly threadId: string;
  readonly toolCallId: string;
}

/** A host app supplies committed thread identity and its connected presentation. */
export interface AssistantThreadHostCapability {
  /**
   * A thread's direct child threads, in delegation order. Child threads are
   * never listed as threads; a host without delegation omits this.
   */
  childThreads?(threadId: string): Promise<readonly AssistantThreadHostChild[]>;
  createThread(resourceId: string): Promise<AssistantMemoryThread>;
  /**
   * For an identity this host owns: the threads it physically deleted, the
   * thread and every child thread under it, children first. Undefined for an
   * identity it does not own, which stays with history.
   */
  deleteThread(threadId: string): Promise<readonly string[] | undefined>;
  /**
   * BST-1932: true for a thread this host listed in its catalog, so the threads
   * panel reads its children from the host; a host without delegation omits it.
   */
  isHostThread?(threadId: string): boolean;
  /** Omitted by a host that reports no usage; cost views then count history only. */
  readonly ledger?: AssistantThreadHostLedger;
  listThreads(resourceId: string): Promise<readonly AssistantMemoryThread[]>;
  /** True only for an identity this host owns; its metadata never reaches history. */
  ownsThread(threadId: string): Promise<boolean>;
  /** Omitted by a host that answers no provider reads (web uses its own server). */
  readonly providers?: AssistantHostProviders;
  /**
   * Every committed version of every canvas of a thread this host owns, oldest
   * first per canvas; undefined for a thread it does not own, which has no
   * canvas owner and fails the Canvas panel's read.
   */
  readCanvases?(
    threadId: string
  ): Promise<ReadonlyMap<string, readonly AssistantThreadHostCanvasVersion[]> | undefined>;
  /** Commits an owned thread's title through the host; it never reaches history. */
  renameThread(threadId: string, title: string): Promise<void>;
  /**
   * `onRunningChange` reports the rendered view's own run state, so a tab
   * closed mid-run keeps its view mounted and observing (BST-1844).
   * `providerReadErrors` are the availability status's credential read
   * failures, which the composer's pre-send notice names.
   */
  renderThread(
    threadId: string,
    isVisible: boolean,
    onRunningChange?: (threadId: string, running: boolean) => void,
    providerReadErrors?: Partial<Record<SupportedProvider, string>>
  ): ReactNode | undefined;
  /**
   * BST-1932: a child thread as its committed origin names it, so a restored
   * tab address is authorized by the host before it mounts. Rejects for any
   * thread that is not a host child.
   */
  resolveChildThread?(threadId: string): Promise<AssistantThreadHostChild>;
  /**
   * The rewind owner (restore to before a message) of a thread this host
   * owns; undefined for a thread it does not own, which history rewinds. A
   * host without rewinds omits it.
   */
  rewindPort?(threadId: string): RewindPort | undefined;
  /** Omitted by a host that reports no run state; its threads then show none. */
  readonly runs?: AssistantThreadHostRuns;
  /**
   * Gap 10: the host's own message and title arms for a Threads panel query,
   * best first, each match on its thread's committed selected path. History's
   * search fuses them into one list. A host without search omits this.
   */
  searchThreads?(
    query: string,
    semantic?: AssistantThreadSearchSemantic
  ): Promise<ThreadSearchExtraArms>;
  /**
   * The host's semantic-arm backlog, embedded by this renderer's search
   * embedder. A host without search vectors omits it.
   */
  readonly searchVectors?: HostThreadSearchVectors;
  /**
   * Called when an owned thread commits a canvas version while a view of it
   * is mounted, so a canvas reader re-reads through `readCanvases`. Omitted by
   * a host without live canvases. Returns the unsubscribe.
   */
  subscribeCanvases?(threadId: string, listener: () => void): () => void;
  /**
   * BST-1932: told the thread whose children changed status, when the host
   * says so; a host without delegation omits it.
   */
  subscribeChildren?(listener: (threadId: string) => void): () => void;
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

const NO_HOST_LEDGER: AssistantThreadHostLedgerSnapshot = { rootUsage: [], runs: [], usage: [] };
const readNoHostLedger = (): AssistantThreadHostLedgerSnapshot => NO_HOST_LEDGER;

/** The host's committed runs and usage; empty where no host reports them (web). */
export function useAssistantThreadHostLedger(): AssistantThreadHostLedgerSnapshot {
  const ledger = useAssistantThreadHost()?.ledger;
  const read = ledger?.getSnapshot ?? readNoHostLedger;
  return useSyncExternalStore(ledger?.subscribe ?? subscribeNoHostRuns, read, read);
}

/** The host's run state for its threads; empty where no host reports one (web). */
export function useAssistantThreadHostRuns(): ReadonlyMap<string, AssistantThreadHostRun> {
  const runs = useAssistantThreadHost()?.runs;
  const read = runs?.getSnapshot ?? readNoHostRuns;
  return useSyncExternalStore(runs?.subscribe ?? subscribeNoHostRuns, read, read);
}

/**
 * BST-1932: a deleted host thread takes its child threads with it, so their
 * open workspace tabs close, as legacy's did with their root's workspace.
 */
function closeDeletedChildTabs(threadIds: readonly string[]): void {
  const deleted = new Set(threadIds);
  const workspace = useWorkspaceTabSelectionStore.getState();
  const closing = workspace.openAppIds.filter((appId) => {
    const tab = readHostChildWorkspaceTab(appId);
    return tab !== undefined && deleted.has(tab.threadId);
  });
  if (closing.length > 0) {
    workspace.closeApps(closing);
  }
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
    const deleted = await host.deleteThread(threadId);
    if (!deleted) {
      await repository.deleteThread(threadId);
      return;
    }
    closeDeletedChildTabs(deleted);
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
  // A history UPDATE would match no host row and report success, so an owned
  // title commits through the host; a refusal rejects before history.
  const renameThread = async (threadId: string, title: string): Promise<void> => {
    if (await host.ownsThread(threadId)) {
      await host.renameThread(threadId, title);
      return;
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
              const deleted = await host.deleteThread(threadId);
              if (deleted) {
                closeDeletedChildTabs(deleted);
              } else {
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
