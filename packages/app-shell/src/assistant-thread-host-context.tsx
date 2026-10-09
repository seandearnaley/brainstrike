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
import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';

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

/** A host app supplies committed thread identity and its connected presentation. */
export interface AssistantThreadHostCapability {
  createThread(resourceId: string): Promise<AssistantMemoryThread>;
  /** True only for an identity owned and physically deleted by this host. */
  deleteThread(threadId: string): Promise<boolean>;
  /** Omitted by a host that reports no usage; cost views then count history only. */
  readonly ledger?: AssistantThreadHostLedger;
  listThreads(resourceId: string): Promise<readonly AssistantMemoryThread[]>;
  /** True only for an identity this host owns; its metadata never reaches history. */
  ownsThread(threadId: string): Promise<boolean>;
  /** Omitted by a host that answers no provider reads (web uses its own server). */
  readonly providers?: AssistantHostProviders;
  /**
   * Every committed version of every canvas of a thread this host owns, oldest
   * first per canvas; undefined for a thread it does not own (history owns it).
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
  /** Omitted by a host that reports no run state; its threads then show none. */
  readonly runs?: AssistantThreadHostRuns;
  /**
   * Called when an owned thread commits a canvas version while a view of it
   * is mounted, so a canvas reader re-reads through `readCanvases`. Omitted by
   * a host without live canvases. Returns the unsubscribe.
   */
  subscribeCanvases?(threadId: string, listener: () => void): () => void;
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
