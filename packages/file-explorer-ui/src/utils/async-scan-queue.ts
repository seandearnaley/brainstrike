import type { IFileNode } from '@brainstrike/types';

/**
 * One settled directory-read outcome flowing through the throughput scan.
 */
export interface ScanResult {
  children: IFileNode[];
  error: unknown | null;
  node: IFileNode;
}

/**
 * FIFO handoff between concurrent adapter reads and the single-threaded
 * drain loop. Results pushed while a waiter is suspended resolve it
 * directly; otherwise they buffer in arrival order. `close` is idempotent
 * in effect: every current and future `takeNext` resolves `undefined` once
 * closed, so exactly-one close per batch is a correctness requirement of
 * the caller, not of this queue.
 */
export interface AsyncScanQueue {
  close: () => void;
  push: (result: ScanResult) => void;
  takeNext: () => Promise<ScanResult | undefined>;
}

/**
 * Single-threaded-concurrency assumption: push/flush/close mutate state
 * synchronously between awaits, so no locking exists and FIFO order is
 * guaranteed by construction.
 */
export function createAsyncScanQueue(settledResults: ScanResult[]): AsyncScanQueue {
  const waiters: Array<(result: ScanResult | undefined) => void> = [];
  let closed = false;

  const flushClosedWaiters = (): void => {
    if (!(closed && waiters.length > 0)) {
      return;
    }
    for (const waiter of waiters.splice(0)) {
      waiter(undefined);
    }
  };

  return {
    close: () => {
      closed = true;
      flushClosedWaiters();
    },
    push: (result) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(result);
        return;
      }
      settledResults.push(result);
    },
    takeNext: async (): Promise<ScanResult | undefined> => {
      if (settledResults.length > 0) {
        return settledResults.shift();
      }
      if (closed) {
        return;
      }
      return new Promise<ScanResult | undefined>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}
