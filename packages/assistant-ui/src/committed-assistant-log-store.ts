import { createLogger } from '@brainstrike/logging';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogProjectionOptions,
  type CommittedAssistantLogRow,
  type CommittedAssistantLogView,
  CommittedRowUnreadableError,
} from './committed-assistant-log-projection';
import type {
  CommittedAssistantSnapshot,
  CommittedAssistantStore,
} from './committed-assistant-store';
import { type ThreadTokenUsage, useContextUsageStore } from './context-usage-store';
import type { LiveShellOutputs } from './live-shell-outputs';
import { displayedBranchRunIds, ThreadContextFold } from './thread-context-fold';
import {
  nextThreadContextRecord,
  type ThreadContextRecord,
  useThreadContextStore,
} from './thread-context-store';

const logger = createLogger('CommittedAssistantLogStore');

/** Owner view fields pass through; this source has already applied committed gap ordering. */
export interface CommittedAssistantLogSourceSnapshot {
  readonly connected: boolean;
  readonly error: string | undefined;
  readonly extras?: CommittedAssistantSnapshot['extras'];
  readonly isDisabled?: boolean;
  readonly isLoading?: boolean;
  readonly rows: readonly CommittedAssistantLogRow[];
  readonly state?: CommittedAssistantSnapshot['state'];
}

export interface CommittedAssistantLogSource {
  readonly getSnapshot: () => CommittedAssistantLogSourceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface CommittedAssistantLogStoreOptions extends CommittedAssistantLogProjectionOptions {
  /** Running commands' live output, fed by the owner from uncommitted host telemetry. */
  readonly liveShellOutputs?: LiveShellOutputs;
  readonly source: CommittedAssistantLogSource;
}

/**
 * Passive consumer bridge from the owner's CommittedThreadSession to the real
 * assistant-ui ExternalStore. The owner connects/disconnects the session and
 * admits commands. No transport, model, writer or command ID is created here.
 * Construct/dispose alongside the owner session, outside React render.
 */
export class CommittedAssistantLogStore implements CommittedAssistantStore {
  readonly threadId: string;
  readonly liveShellOutputs: LiveShellOutputs | undefined;
  private readonly projection: CommittedAssistantLogProjection;
  /**
   * Why the presentation stopped: a committed row it could not read. The view
   * stays at the last row it showed, and says so, rather than throwing into the
   * owner's event delivery, which would freeze it silently.
   */
  private failure: string | undefined;
  private readonly listeners = new Set<() => void>();
  /** This store's last record in the thread context store, if any. */
  private recordedContext: ThreadContextRecord | undefined;
  private readonly release: () => void;
  private snapshot: CommittedAssistantSnapshot;

  constructor(options: CommittedAssistantLogStoreOptions) {
    this.threadId = options.threadId;
    this.liveShellOutputs = options.liveShellOutputs;
    this.projection = new CommittedAssistantLogProjection(options);
    const contextFold = new ThreadContextFold();
    let displayedContext: ThreadTokenUsage | undefined;
    let displayedBreakdown: CommittedAssistantLogView['contextBreakdown'];
    const read = (): CommittedAssistantSnapshot => {
      const source = options.source.getSnapshot();
      const view = this.fold(() => this.projection.acceptCommitted(source.rows));
      // The thread context map's fold reads the same rows (ADR-0021).
      const snapshot = contextFold.accept(source.rows);
      const branchRunIds = displayedBranchRunIds(view.repository, snapshot.runs);
      const recorded = nextThreadContextRecord(this.recordedContext, snapshot, branchRunIds);
      if (recorded !== this.recordedContext) {
        this.recordedContext = recorded;
        useThreadContextStore.getState().record(this.threadId, recorded);
      }
      if (view.contextUsage && view.contextUsage !== displayedContext) {
        displayedContext = view.contextUsage;
        useContextUsageStore.getState().recordUsage(this.threadId, displayedContext);
      }
      if (view.contextBreakdown && view.contextBreakdown !== displayedBreakdown) {
        displayedBreakdown = view.contextBreakdown;
        useContextUsageStore.getState().recordBreakdown(this.threadId, displayedBreakdown);
      }
      return {
        connection:
          source.error === undefined ? (source.connected ? 'connected' : 'disconnected') : 'failed',
        contextUsage: view.contextUsage,
        error: this.failure ?? source.error,
        extras: source.extras,
        isDisabled: source.isDisabled,
        isLoading: source.isLoading ?? false,
        isRunning: view.isRunning,
        observationWithheld: view.observationWithheld,
        repository: view.repository,
        state: source.state,
      };
    };
    this.snapshot = read();
    this.release = options.source.subscribe(() => {
      const next = read();
      const previous = this.snapshot;
      if (
        next.repository === previous.repository &&
        next.contextUsage === previous.contextUsage &&
        next.connection === previous.connection &&
        next.error === previous.error &&
        next.extras === previous.extras &&
        next.state === previous.state &&
        next.isDisabled === previous.isDisabled &&
        next.isLoading === previous.isLoading &&
        next.isRunning === previous.isRunning &&
        next.observationWithheld === previous.observationWithheld
      ) {
        return;
      }
      this.snapshot = next;
      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  readonly getSnapshot = (): CommittedAssistantSnapshot => this.snapshot;

  /**
   * One uncommitted `run/telemetry` chunk from the owner: the model's live text
   * and reasoning show in the open step until its committed parts replace them.
   */
  acceptTelemetry(runId: string, chunk: unknown): void {
    const view = this.fold(() => this.projection.acceptLive(runId, chunk));
    const error = this.failure ?? this.snapshot.error;
    if (view.repository === this.snapshot.repository && error === this.snapshot.error) {
      return;
    }
    this.snapshot = { ...this.snapshot, error, repository: view.repository };
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Apply committed rows or live chunks to the presentation until it meets one
   * it cannot read; from then on it holds its last view and the failure.
   */
  private fold(apply: () => CommittedAssistantLogView): CommittedAssistantLogView {
    if (this.failure !== undefined) {
      return this.projection.getSnapshot();
    }
    try {
      return apply();
    } catch (cause) {
      this.failure =
        cause instanceof CommittedRowUnreadableError
          ? cause.message
          : `This conversation cannot be shown: ${cause instanceof Error ? cause.message : String(cause)}`;
      logger.error('Committed conversation presentation stopped', {
        error: cause,
        threadId: this.threadId,
      });
      return this.projection.getSnapshot();
    }
  }

  /** Committed run/interaction identities for owner command routing, never SDK aliases. */
  readonly getCommittedView = (): CommittedAssistantLogView => this.projection.getSnapshot();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispose(): void {
    this.release();
    this.listeners.clear();
    // Delivered file text leaves with its view; another live view's record stays.
    const context = useThreadContextStore.getState();
    if (this.recordedContext && context.byThread[this.threadId] === this.recordedContext) {
      context.clearThread(this.threadId);
    }
  }
}
