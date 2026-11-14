import type {
  OpenRouterModelMetadataSnapshot,
  ProviderVerificationSnapshot,
  SkillsScanResultSummary,
  SupportedProvider,
  UserSlashCommandsListResult,
} from '@brainstrike/assistant-contract';
import type {
  AssistantMemoryThread,
  AssistantThreadCatalogRepository,
  AssistantThreadMetadata,
  AssistantThreadRunStatus,
  CrossRootUsageRow,
  RunLedgerRow,
  ThreadWorkspaceRepository,
} from '@brainstrike/assistant-data';
import type { HostUsageRecord } from '@brainstrike/assistant-data/cost-tracking';
import type { ThreadContextRecord } from '@brainstrike/assistant-ui/thread-context-store';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import type { WorkspaceTrustCapability } from '@brainstrike/settings-ui/settings/system/workspace-trust';
import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';
import { closeBrowserPagesOf } from './browser-pane/browser-pages';
import type { RewindPort } from './changes/rewind-port';
import { readHostChildWorkspaceTab } from './host-child-workspace-tab';
import type { ThreadSearchExtraArms } from './thread-search-service';

/** A host thread's latest committed root run, read as the thread badges read a run row. */
export interface AssistantThreadHostRun {
  /** The committed finish time; null while running or when the host recorded none. */
  readonly completedAt: Date | null;
  /** The run is waiting on its user: an approval, question or plan is unanswered. */
  readonly needsInput: boolean;
  /** The committed start time; null when the host recorded none. */
  readonly startedAt: Date | null;
  readonly status: Exclude<AssistantThreadRunStatus, 'cancelling'>;
  /**
   * The kinds of unanswered request the run waits on, as the host committed
   * them; present while `needsInput` is true. A network consent is asked as an
   * approval is.
   */
  readonly waitingOn?: readonly ('approval' | 'network' | 'plan' | 'question')[];
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

/**
 * ADR-0029 stage 2: the skills and user slash commands on the host's live roots
 * and home directory, scanned as its runs scan them, for the Settings → Skills
 * panel and the composer's "/" menu. ADR-0032: project tiers come only from
 * the folders the person trusted, and each folder's trust is read and set here.
 */
export interface AssistantHostWorkspaceDiscovery extends WorkspaceTrustCapability {
  listCommands(): Promise<UserSlashCommandsListResult>;
  scanSkills(): Promise<SkillsScanResultSummary>;
}

/**
 * The folder a project's section is named by, which Move to project… moves: an open folder's
 * root, or a repository found inside an open folder, which has no root, by its own checkout's
 * path as the host's worktree listing names it (ADR-0034 build decisions, BST-2511).
 */
export type ThreadProjectFolder = { readonly rootId: string } | { readonly repositoryPath: string };

/**
 * The project Rename project… names: one the store has, or the project of a repository found
 * inside an open folder that has none yet, by its own checkout's path, which its first name makes
 * (ADR-0034 build decisions, BST-2520).
 */
export type ThreadProjectRef = { readonly projectId: string } | { readonly repositoryPath: string };

/**
 * ADR-0034: the person's projects, which the host's root registry writes. Each call resolves once
 * its change committed and rejects with the host's refusal, which the caller shows.
 */
export interface AssistantHostProjects {
  /**
   * Moves `folder` into the project `projectId`, so its threads list there. The folder's trust
   * and approved hooks stay its own.
   */
  join(folder: ThreadProjectFolder, projectId: string): Promise<void>;
  /**
   * Points the record of a folder that moved at the folder the person picks; its threads and
   * project follow it. Resolves the folder as mounted, or null when the person cancelled.
   */
  locate(rootId: string): Promise<{ readonly path: string; readonly rootId: string } | null>;
  /**
   * Names the project; an empty name clears it, so it is named by its folder again. A
   * repository's first name makes its project.
   */
  rename(project: ThreadProjectRef, name: string): Promise<void>;
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

/** One canvas at its latest committed version, as the Artifacts gallery lists it. */
export interface AssistantThreadHostArtifact {
  readonly canvasId: string;
  readonly createdBy: string;
  /** The top-level thread the canvas's thread belongs to; itself for a top-level thread. */
  readonly rootThreadId: string;
  readonly threadId: string;
  readonly title: string;
  /** When the latest version was committed (ISO 8601). */
  readonly updatedAt: string;
  readonly version: number;
}

/** The Artifacts gallery's reads: every canvas of every thread the host owns. */
export interface AssistantThreadHostArtifacts {
  /** Every canvas at its latest version, without its document, newest first. */
  list(): Promise<readonly AssistantThreadHostArtifact[]>;
  /** One canvas's latest version with its document; null when it no longer exists. */
  read(threadId: string, canvasId: string): Promise<AssistantThreadHostCanvasVersion | null>;
}

/** A canvas version a mounted thread view saw a run commit, as it happened. */
export interface AssistantThreadHostCanvasCommit {
  readonly canvasId: string;
  readonly threadId: string;
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

/** One read of a thread's context record, as `openThreadContext` reports it. */
export interface AssistantThreadContextSnapshot {
  /** Why the thread's log could not be read; a reader shows it, never an empty map. */
  readonly error?: string;
  readonly isLoading: boolean;
  /** Absent until the log's replay has been read. */
  readonly record?: ThreadContextRecord;
}

/** A thread's committed log, folded for the thread context map; it reads until closed. */
export interface AssistantThreadContextSource {
  close(): void;
  readonly getSnapshot: () => AssistantThreadContextSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

/** A host app supplies committed thread identity and its connected presentation. */
export interface AssistantThreadHostCapability {
  /** The Artifacts gallery's reads; a host without canvases omits it. */
  readonly artifacts?: AssistantThreadHostArtifacts;
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
  /**
   * ADR-0034 (BST-2513): a thread with no folder of its own gets a new project folder. The host
   * asks for a parent with the folder picker, makes the folder there, opens it as a folder of the
   * person's with a project of its own and binds the thread to it. Resolves the new folder, or
   * null when the person cancelled; rejects with the host's typed refusal. A host without
   * scratch folders omits it.
   */
  newProjectFolder?(
    threadId: string
  ): Promise<{ readonly path: string; readonly rootId: string } | null>;
  /**
   * BST-2021: a thread's committed log, folded as its own view folds it, for a
   * subagent's lane in its parent's Context tab. A host without a committed
   * run log omits this.
   */
  openThreadContext?(threadId: string): Promise<AssistantThreadContextSource>;
  /** True only for an identity this host owns; its metadata never reaches history. */
  ownsThread(threadId: string): Promise<boolean>;
  /** Naming, joining and relinking projects; a host without a root registry (web) omits it. */
  readonly projects?: AssistantHostProjects;
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
   * The new-thread composer (`newThreadId(resourceId)`): the thread's own
   * composer and controls before the thread exists. Its first send creates
   * the thread; nothing is created before then.
   */
  renderNewThread(
    resourceId: string,
    providerReadErrors?: Partial<Record<SupportedProvider, string>>
  ): ReactNode;
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
  searchThreads?(query: string): Promise<ThreadSearchExtraArms>;
  /**
   * Told each canvas version a run commits while a view of its thread is
   * mounted, as it commits (never the versions a view loads with its history),
   * so the workspace can open that canvas's tab. Returns the unsubscribe.
   */
  subscribeCanvasCommits?(listener: (commit: AssistantThreadHostCanvasCommit) => void): () => void;
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
  /**
   * Called when a host thread's committed catalog entry changes: its title, or
   * the workspace the host moved it to. A host without live entries omits it.
   */
  subscribeEntryChanges?(listener: () => void): () => void;
  /**
   * ADR-0034: the thread's scratch folder becomes a project. The host asks where with the folder
   * picker, moves the folder there, records it as a folder of the person's under the same root id
   * and binds the thread to it. Resolves where the folder now is, or null when the person
   * cancelled; rejects with the host's typed refusal. A host without scratch folders omits it.
   */
  turnScratchIntoProject?(
    threadId: string
  ): Promise<{ readonly path: string; readonly rootId: string } | null>;
  /**
   * Commits an owned thread's workspace binding keys through the host. Any key
   * the host does not own rejects before a request, never reaching history.
   */
  updateThreadBinding(threadId: string, metadata: AssistantThreadMetadata): Promise<void>;
  /** Skills and user slash commands; a host that scans no roots (web) omits it. */
  readonly workspaceDiscovery?: AssistantHostWorkspaceDiscovery;
  workspaceRepository(): ThreadWorkspaceRepository;
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

/** Desktop catalog operations belong only to the attached host. */
export function createHostAssistantThreadRepository(
  host: AssistantThreadHostCapability
): AssistantThreadCatalogRepository {
  const assertOwned = async (threadId: string): Promise<void> => {
    if (!(await host.ownsThread(threadId))) {
      throw new Error('This conversation is not owned by the attached agent host.');
    }
  };
  const deleteThread = async (threadId: string): Promise<void> => {
    const deleted = await host.deleteThread(threadId);
    if (!deleted) {
      throw new Error('This conversation is not owned by the attached agent host.');
    }
    closeDeletedChildTabs(deleted);
    closeBrowserPagesOf(new Set(deleted));
  };
  return {
    createThread: (resourceId) => host.createThread(resourceId),
    deleteThread,
    deleteThreads: async (threadIds) => {
      for (const threadId of threadIds) {
        await deleteThread(threadId);
      }
    },
    listThreads: (resourceId) => host.listThreads(resourceId),
    renameThread: async (threadId, title) => {
      await assertOwned(threadId);
      await host.renameThread(threadId, title);
    },
    updateThreadMetadata: async (threadId, metadata) => {
      await assertOwned(threadId);
      await host.updateThreadBinding(threadId, metadata);
    },
  };
}
