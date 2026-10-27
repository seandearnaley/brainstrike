import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import type { AssistantThreadHostCanvasCommit } from '@brainstrike/app-shell/assistant-thread-host-context';
import { CANVAS_STATE_KEY_PREFIX } from '@brainstrike/host-capabilities/canvas-state';
import type { CommittedHostRunSource } from './host-thread-runs';

/** The canvas a committed canvas version belongs to, or undefined for any other row. */
function committedCanvasId(row: HostLogRow): string | undefined {
  return row.event.type === 'tool.state.updated' &&
    row.event.key.startsWith(CANVAS_STATE_KEY_PREFIX)
    ? row.event.key.slice(CANVAS_STATE_KEY_PREFIX.length)
    : undefined;
}

/**
 * Which host threads' canvases changed, as this window's mounted views see
 * their committed logs. A canvas reader subscribes per thread and re-reads
 * the thread's committed canvases on each signal; a commit listener hears
 * each canvas version a run commits while a view watches.
 */
export class HostThreadCanvases {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly commitListeners = new Set<(commit: AssistantThreadHostCanvasCommit) => void>();

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

  readonly subscribeCommits = (
    listener: (commit: AssistantThreadHostCanvasCommit) => void
  ): (() => void) => {
    this.commitListeners.add(listener);
    return () => {
      this.commitListeners.delete(listener);
    };
  };

  /**
   * Follow a mounted view's committed session; returns its release. Its first
   * loaded rows count too: a reader may have read before the view caught up.
   * Only rows past the replay's boundary were committed while the view
   * watched, so only they reach commit listeners: reopening a thread never
   * re-announces its canvases.
   */
  observe(threadId: string, source: CommittedHostRunSource): () => void {
    let cursor = 0;
    const sync = (): void => {
      const { isLoading, replayedThrough, rows } = source.getSnapshot();
      if (isLoading || rows.length === cursor) {
        return;
      }
      const added = rows.slice(cursor);
      cursor = rows.length;
      const versions = added.flatMap((row) => {
        const canvasId = committedCanvasId(row);
        return canvasId === undefined ? [] : [{ canvasId, seq: row.seq }];
      });
      if (versions.length === 0) {
        return;
      }
      for (const listener of this.listeners.get(threadId) ?? []) {
        listener();
      }
      for (const { canvasId, seq } of versions) {
        if (replayedThrough !== undefined && seq > replayedThrough) {
          for (const listener of this.commitListeners) {
            listener({ canvasId, threadId });
          }
        }
      }
    };
    sync();
    return source.subscribe(sync);
  }
}
