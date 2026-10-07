import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogProjectionOptions,
  type CommittedAssistantLogRow,
  type CommittedAssistantLogView,
} from './committed-assistant-log-projection';
import type {
  CommittedAssistantSnapshot,
  CommittedAssistantStore,
} from './committed-assistant-store';
import { type ThreadTokenUsage, useContextUsageStore } from './context-usage-store';

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
  private readonly projection: CommittedAssistantLogProjection;
  private readonly listeners = new Set<() => void>();
  private readonly release: () => void;
  private snapshot: CommittedAssistantSnapshot;

  constructor(options: CommittedAssistantLogStoreOptions) {
    this.threadId = options.threadId;
    this.projection = new CommittedAssistantLogProjection(options);
    let displayedContext: ThreadTokenUsage | undefined;
    const read = (): CommittedAssistantSnapshot => {
      const source = options.source.getSnapshot();
      const view = this.projection.acceptCommitted(source.rows);
      if (view.contextUsage && view.contextUsage !== displayedContext) {
        displayedContext = view.contextUsage;
        useContextUsageStore.getState().recordUsage(this.threadId, displayedContext);
      }
      return {
        connection:
          source.error === undefined ? (source.connected ? 'connected' : 'disconnected') : 'failed',
        contextUsage: view.contextUsage,
        error: source.error,
        extras: source.extras,
        isDisabled: source.isDisabled,
        isLoading: source.isLoading ?? false,
        isRunning: view.isRunning,
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
        next.isRunning === previous.isRunning
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

  /** Committed run/interaction identities for owner command routing, never SDK aliases. */
  readonly getCommittedView = (): CommittedAssistantLogView => this.projection.getSnapshot();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispose(): void {
    this.release();
    this.listeners.clear();
  }
}
