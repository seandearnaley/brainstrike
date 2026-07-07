export type BackgroundWorkPauseReason = 'local-llm';

export interface BackgroundWorkArbiterSnapshot {
  automaticPauseReasons: BackgroundWorkPauseReason[];
  backgroundIndexingPaused: boolean;
  manualPause: boolean;
}

export interface BackgroundWorkPauseHandler {
  pause: () => Promise<void> | void;
}

type BackgroundWorkSubscriber = () => void;

function arePauseReasonsEqual(
  left: readonly BackgroundWorkPauseReason[],
  right: readonly BackgroundWorkPauseReason[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((reason, index) => reason === right[index]);
}

class BackgroundWorkArbiter {
  private readonly pauseHandlers = new Map<string, BackgroundWorkPauseHandler>();
  private readonly pauseReasonCounts = new Map<BackgroundWorkPauseReason, number>();
  private readonly subscribers = new Set<BackgroundWorkSubscriber>();
  private manualPause = false;
  private snapshot: BackgroundWorkArbiterSnapshot = {
    automaticPauseReasons: [],
    backgroundIndexingPaused: false,
    manualPause: false,
  };

  acquirePauseReason(reason: BackgroundWorkPauseReason): Promise<() => void> {
    const hadAutomaticPause = this.hasAutomaticPause();
    this.pauseReasonCounts.set(reason, (this.pauseReasonCounts.get(reason) ?? 0) + 1);
    this.emit();

    const releasePauseReason = (): void => {
      const nextCount = (this.pauseReasonCounts.get(reason) ?? 0) - 1;
      if (nextCount > 0) {
        this.pauseReasonCounts.set(reason, nextCount);
      } else {
        this.pauseReasonCounts.delete(reason);
      }
      this.emit();
    };

    return (hadAutomaticPause ? Promise.resolve() : this.pauseRegisteredHandlers())
      .catch((error) => {
        releasePauseReason();
        throw error;
      })
      .then(() => {
        let released = false;
        return () => {
          if (released) {
            return;
          }
          released = true;
          releasePauseReason();
        };
      });
  }

  getSnapshot(): BackgroundWorkArbiterSnapshot {
    return this.snapshot;
  }

  registerPauseHandler(id: string, handler: BackgroundWorkPauseHandler): () => void {
    this.pauseHandlers.set(id, handler);
    return () => {
      if (this.pauseHandlers.get(id) !== handler) {
        return;
      }
      this.pauseHandlers.delete(id);
    };
  }

  setManualPause(paused: boolean): void {
    if (this.manualPause === paused) {
      return;
    }
    this.manualPause = paused;
    this.emit();
  }

  subscribe(subscriber: BackgroundWorkSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  reset(): void {
    this.manualPause = false;
    this.pauseReasonCounts.clear();
    this.pauseHandlers.clear();
    this.emit();
  }

  private emit(): void {
    const automaticPauseReasons = [...this.pauseReasonCounts.entries()]
      .filter(([, count]) => count > 0)
      .map(([reason]) => reason)
      .sort();
    const nextSnapshot: BackgroundWorkArbiterSnapshot = {
      automaticPauseReasons,
      backgroundIndexingPaused: this.manualPause || automaticPauseReasons.length > 0,
      manualPause: this.manualPause,
    };
    const currentSnapshot = this.snapshot;
    if (
      currentSnapshot.manualPause === nextSnapshot.manualPause &&
      currentSnapshot.backgroundIndexingPaused === nextSnapshot.backgroundIndexingPaused &&
      arePauseReasonsEqual(
        currentSnapshot.automaticPauseReasons,
        nextSnapshot.automaticPauseReasons
      )
    ) {
      return;
    }
    this.snapshot = nextSnapshot;
    for (const subscriber of this.subscribers) {
      subscriber();
    }
  }

  private hasAutomaticPause(): boolean {
    for (const count of this.pauseReasonCounts.values()) {
      if (count > 0) {
        return true;
      }
    }
    return false;
  }

  private async pauseRegisteredHandlers(): Promise<void> {
    const handlers = [...this.pauseHandlers.values()];
    for (const handler of handlers) {
      await handler.pause();
    }
  }
}

const arbiter = new BackgroundWorkArbiter();

export function acquireBackgroundWorkPauseReason(
  reason: BackgroundWorkPauseReason
): Promise<() => void> {
  return arbiter.acquirePauseReason(reason);
}

export function getBackgroundWorkArbiterSnapshot(): BackgroundWorkArbiterSnapshot {
  return arbiter.getSnapshot();
}

export function registerBackgroundWorkPauseHandler(
  id: string,
  handler: BackgroundWorkPauseHandler
): () => void {
  return arbiter.registerPauseHandler(id, handler);
}

export function setBackgroundWorkManualPause(paused: boolean): void {
  arbiter.setManualPause(paused);
}

export function subscribeToBackgroundWorkArbiter(subscriber: BackgroundWorkSubscriber): () => void {
  return arbiter.subscribe(subscriber);
}

export function getBackgroundWorkPauseReasonLabel(reason: BackgroundWorkPauseReason): string {
  switch (reason) {
    case 'local-llm':
      return 'Paused for local assistant';
  }
}

export function getBackgroundWorkPauseReasonLabels(
  reasons: readonly BackgroundWorkPauseReason[]
): string[] {
  return reasons.map((reason) => getBackgroundWorkPauseReasonLabel(reason));
}

export function __resetBackgroundWorkArbiterForTests(): void {
  arbiter.reset();
}
