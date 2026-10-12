import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { CANVAS_STATE_KEY_PREFIX } from '@brainstrike/host-capabilities/canvas-state';
import type { CommittedHostRunSource } from './host-thread-runs';

function isCanvasVersion(row: HostLogRow): boolean {
  return (
    row.event.type === 'tool.state.updated' && row.event.key.startsWith(CANVAS_STATE_KEY_PREFIX)
  );
}

/**
 * Which host threads' canvases changed, as this window's mounted views see
 * their committed logs. A canvas reader subscribes per thread and re-reads
 * the thread's committed canvases on each signal.
 */
export class HostThreadCanvases {
  private readonly listeners = new Map<string, Set<() => void>>();

  readonly subscribe = (threadId: string, listener: () => void): (() => void) => {
    const listeners = this.listeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.listeners.get(threadId) === listeners) {
        this.listeners.delete(threadId);
      }
    };
  };

  /**
   * Follow a mounted view's committed session; returns its release. Its first
   * loaded rows count too: a reader may have read before the view caught up.
   */
  observe(threadId: string, source: CommittedHostRunSource): () => void {
    let cursor = 0;
    const sync = (): void => {
      const { isLoading, rows } = source.getSnapshot();
      if (isLoading || rows.length === cursor) {
        return;
      }
      const added = rows.slice(cursor);
      cursor = rows.length;
      if (added.some(isCanvasVersion)) {
        for (const listener of this.listeners.get(threadId) ?? []) {
          listener();
        }
      }
    };
    sync();
    return source.subscribe(sync);
  }
}
