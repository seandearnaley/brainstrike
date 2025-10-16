export type Listener<TEvent> = (event: TEvent) => void;

export class ProgressEmitter<TEvent> {
  private readonly listeners = new Set<Listener<TEvent>>();

  add(listener: Listener<TEvent>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: TEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export function estimateHardwareConcurrency(): number {
  if (typeof navigator !== 'undefined') {
    const concurrency = Number(
      (navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency
    );
    if (Number.isFinite(concurrency) && concurrency > 0) {
      return concurrency;
    }
  }
  return 2;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  if (error instanceof Error) {
    return error.name === 'AbortError';
  }
  return false;
}

export function supportsWorkers(): boolean {
  // Type-only detection keeps us CSP-safe. Any instantiation errors will be caught during adapter creation.
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}
