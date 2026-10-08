import { type Json, jsonValue } from './json-value.js';
import type { HostToolState } from './ports.js';
import type { HostEvent, HostLogRow } from './protocol.js';

type Updated = Extract<HostEvent, { type: 'tool.state.updated' }>;

/**
 * Core-owned per-thread tool state (task list, canvases): the latest committed
 * `tool.state.updated` value per key. The run log is the only record, so
 * restart folds it back and thread deletion erases it with the thread.
 */
export class HostToolStates {
  private readonly threads = new Map<string, Map<string, Json>>();
  private readonly locks = new Map<string, Promise<void>>();

  fold(row: HostLogRow): void {
    if (row.event.type !== 'tool.state.updated') {
      return;
    }
    let state = this.threads.get(row.threadId);
    if (!state) {
      state = new Map();
      this.threads.set(row.threadId, state);
    }
    state.set(row.event.key, row.event.value);
  }

  forgetThread(threadId: string): void {
    this.threads.delete(threadId);
  }

  capability(
    scope: {
      readonly assertCurrent: () => void;
      readonly runId: string;
      readonly threadId: string;
      readonly toolCallId: string;
    },
    commit: (event: Updated) => Promise<unknown>
  ): HostToolState {
    const current = (key: string): Json | undefined => this.threads.get(scope.threadId)?.get(key);
    return {
      entries: (prefix) =>
        [...(this.threads.get(scope.threadId) ?? [])]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key, jsonValue(value)] as const),
      read: (key) => {
        const value = current(key);
        return value === undefined ? undefined : jsonValue(value);
      },
      update: async (key, next) => {
        const lock = JSON.stringify([scope.threadId, key]);
        const previous = this.locks.get(lock) ?? Promise.resolve();
        const release = Promise.withResolvers<void>();
        this.locks.set(lock, release.promise);
        await previous;
        try {
          scope.assertCurrent();
          const latest = current(key);
          const value = next(latest === undefined ? undefined : jsonValue(latest));
          if (value === undefined) {
            return;
          }
          await commit({
            key,
            runId: scope.runId,
            toolCallId: scope.toolCallId,
            type: 'tool.state.updated',
            value: jsonValue(value),
          });
        } finally {
          release.resolve();
          if (this.locks.get(lock) === release.promise) {
            this.locks.delete(lock);
          }
        }
      },
    };
  }
}
