import type {
  CanonicalSourceSubscription,
  CanonicalWorkspaceLease,
} from '@brainstrike/canonical-ingestion';
import { ParcelWatchRetirementError } from '@brainstrike/file-system/native-watch';
import type {
  FileSystemChange,
  FileSystemWatchBatchMetadata,
  WatcherHealthTransition,
} from '@brainstrike/types';
import type { MountedWorkspaceRoot } from './workspace-root-types';

interface Dependencies {
  /** Reject without a handle only after cleanup joins; retain typed acquired-handle failures. */
  readonly startWatch: (
    mounted: MountedWorkspaceRoot,
    onBatch: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
    onHealth: (health: WatcherHealthTransition) => void
  ) => Promise<() => Promise<void>>;
}

export interface WorkspaceRootWatchOwner {
  close(): Promise<void>;
  retry(mounted: MountedWorkspaceRoot): Promise<void>;
  subscribe(
    mounted: MountedWorkspaceRoot,
    ...callbacks: Parameters<CanonicalWorkspaceLease['subscribe']>
  ): Promise<CanonicalSourceSubscription>;
}

type SubscriptionArguments = Parameters<CanonicalWorkspaceLease['subscribe']>;

interface Listener {
  active: boolean;
  readonly callbacks: SubscriptionArguments;
  health: WatcherHealthTransition | undefined;
  releaseAbort: () => void;
}

interface OwnedWatch {
  accepting: boolean;
  health: WatcherHealthTransition | undefined;
  readonly listeners: Set<Listener>;
  readonly mounted: MountedWorkspaceRoot;
  producer: number;
  retired: boolean;
  retirement: Promise<void> | undefined;
  retiring: boolean;
  retrying: Promise<void> | undefined;
  starting: Promise<() => Promise<void>>;
  stopped: Promise<void> | undefined;
}

/** One native producer per exact mounted capability; listeners own only their borrow. */
export function createWorkspaceRootWatchOwner(dependencies: Dependencies): WorkspaceRootWatchOwner {
  return new MountedRootWatchOwner(dependencies);
}

class MountedRootWatchOwner implements WorkspaceRootWatchOwner {
  private readonly watches = new Map<string, OwnedWatch>();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly dependencies: Dependencies) {}

  async subscribe(
    mounted: MountedWorkspaceRoot,
    ...callbacks: SubscriptionArguments
  ): Promise<CanonicalSourceSubscription> {
    const context = callbacks[3];
    context.signal.throwIfAborted();
    if (this.closed) {
      throw new Error('Mounted root watch owner is closed.');
    }
    let watch = this.watches.get(mounted.rootId);
    if (watch && watch.mounted !== mounted) {
      throw new Error('Previous mounted root still owns its native watch.');
    }
    if (watch?.retiring || watch?.retrying) {
      throw new Error('Mounted root watch retirement has not completed.');
    }
    watch ??= this.start(mounted);
    const listener: Listener = {
      active: true,
      callbacks,
      health: undefined,
      releaseAbort: () => undefined,
    };
    const deactivate = (): void => {
      listener.active = false;
      listener.releaseAbort();
    };
    context.signal.addEventListener('abort', deactivate, { once: true });
    listener.releaseAbort = () => context.signal.removeEventListener('abort', deactivate);
    watch.listeners.add(listener);
    let closed = false;
    let closing: Promise<void> | undefined;
    const subscription: CanonicalSourceSubscription = {
      close: (): Promise<void> => {
        deactivate();
        watch.listeners.delete(listener);
        if (closed) {
          return Promise.resolve();
        }
        closing ??= (
          watch.retiring || watch.listeners.size === 0 ? this.retire(watch) : Promise.resolve()
        ).then(
          () => {
            closed = true;
          },
          (error: unknown) => {
            closing = undefined;
            throw error;
          }
        );
        return closing;
      },
    };
    try {
      await watch.starting;
      context.signal.throwIfAborted();
      if (this.closed || watch.retiring) {
        throw new Error('Mounted root watch owner closed during acquisition.');
      }
      if (watch.health && listener.active) {
        this.forwardHealth(listener, watch.health);
      }
      return subscription;
    } catch (error) {
      try {
        await subscription.close();
      } catch (retirementError) {
        throw new ParcelWatchRetirementError([error, retirementError], () => this.retire(watch));
      }
      throw error;
    }
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.joinAll().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }

  retry(mounted: MountedWorkspaceRoot): Promise<void> {
    const watch = this.watches.get(mounted.rootId);
    if (this.closed || !watch || watch.mounted !== mounted || watch.retiring) {
      return Promise.reject(new Error('Mounted root watch is unavailable for manual retry.'));
    }
    watch.retrying ??= this.restart(watch).finally(() => {
      watch.retrying = undefined;
    });
    return watch.retrying;
  }

  private start(mounted: MountedWorkspaceRoot): OwnedWatch {
    const watch: OwnedWatch = {
      accepting: true,
      health: undefined,
      listeners: new Set(),
      mounted,
      producer: 0,
      retired: false,
      retirement: undefined,
      retiring: false,
      retrying: undefined,
      starting: Promise.resolve().then(() => this.startNative(watch)),
      stopped: undefined,
    };
    this.watches.set(mounted.rootId, watch);
    return watch;
  }

  private startNative(watch: OwnedWatch): Promise<() => Promise<void>> {
    const producer = ++watch.producer;
    return this.dependencies.startWatch(
      watch.mounted,
      (changes, metadata) => {
        for (const listener of watch.listeners) {
          if (
            listener.active &&
            watch.accepting &&
            !watch.retiring &&
            watch.producer === producer
          ) {
            listener.callbacks[0](changes, metadata);
          }
        }
      },
      (health) => {
        if (watch.producer !== producer) {
          return;
        }
        watch.health = health;
        for (const listener of watch.listeners) {
          if (!(listener.active && watch.accepting && !watch.retiring)) {
            continue;
          }
          this.forwardHealth(listener, health);
        }
      }
    );
  }

  private async restart(watch: OwnedWatch): Promise<void> {
    watch.accepting = false;
    watch.producer += 1;
    await this.joinNative(watch);
    if (this.closed || watch.retiring || watch.listeners.size === 0) {
      return;
    }
    watch.health = undefined;
    watch.stopped = undefined;
    watch.starting = Promise.resolve().then(() => this.startNative(watch));
    await watch.starting;
    if (this.closed || watch.retiring) {
      return;
    }
    watch.accepting = true;
    for (const listener of watch.listeners) {
      if (!listener.active) {
        continue;
      }
      if (watch.health) {
        this.forwardHealth(listener, watch.health);
      }
      // The unsubscribe/resubscribe gap may have missed events.
      listener.callbacks[1]({ type: 'overflow' });
    }
  }

  private forwardHealth(listener: Listener, health: WatcherHealthTransition): void {
    if (listener.health === health) {
      return;
    }
    listener.health = health;
    listener.callbacks[2](health);
    if (health.state === 'degraded') {
      listener.callbacks[1]({ type: 'overflow' });
    } else if (health.state === 'failed') {
      listener.callbacks[1]({
        message: health.failure?.message ?? 'Native root watcher failed.',
        type: 'errored',
      });
    }
  }

  private retire(watch: OwnedWatch): Promise<void> {
    if (watch.retired) {
      return Promise.resolve();
    }
    watch.retiring = true;
    for (const listener of watch.listeners) {
      listener.active = false;
      listener.releaseAbort();
    }
    watch.listeners.clear();
    watch.retirement ??= (async (): Promise<void> => {
      await watch.retrying;
      await this.joinNative(watch);
      watch.retired = true;
      if (this.watches.get(watch.mounted.rootId) === watch) {
        this.watches.delete(watch.mounted.rootId);
      }
    })().finally(() => {
      watch.retirement = undefined;
    });
    return watch.retirement;
  }

  private joinNative(watch: OwnedWatch): Promise<void> {
    watch.stopped ??= (async (): Promise<void> => {
      let stop: (() => Promise<void>) | undefined;
      try {
        stop = await watch.starting;
      } catch (error) {
        // Startup rejection is returned to its subscriber. Only the typed
        // acquired-handle failure owns a disposer that retirement must join.
        if (error instanceof ParcelWatchRetirementError) {
          stop = error.retire;
        }
      }
      await stop?.();
    })().catch((error: unknown) => {
      watch.stopped = undefined;
      throw error;
    });
    return watch.stopped;
  }

  private async joinAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.watches.values()].map((watch) => this.retire(watch))
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Application mounted root watches did not retire.');
    }
  }
}
