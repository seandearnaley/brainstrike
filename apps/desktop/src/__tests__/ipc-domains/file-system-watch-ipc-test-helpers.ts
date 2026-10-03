import path from 'node:path';
import type { WatcherHealthEvent } from '@brainstrike/types';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { FileSystemWatchEventPayload } from '../../ipc-domains/file-system-watch-ipc';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import {
  createAllowlistedSenderFrame,
  trackTestWindowRole,
} from '../helpers/desktop-ipc-sender-test-helpers';

interface FakeListenerEntry {
  listener: () => void;
  once: boolean;
}

/**
 * A minimal WebContents stand-in modelling on/once/removeListener with real
 * add/remove semantics so listener-accumulation leaks are observable via
 * `listenerCount`. Records the watch events pushed to it.
 */
export class FakeWebContents {
  readonly id: number;
  readonly watchEvents: FileSystemWatchEventPayload[] = [];
  readonly healthEvents: WatcherHealthEvent[] = [];
  private destroyed = false;
  private readonly listeners = new Map<string, FakeListenerEntry[]>();

  constructor(id: number) {
    this.id = id;
  }

  send(channel: string, payload: unknown): void {
    if (channel === DESKTOP_IPC_CHANNELS.files.watchEvent) {
      this.watchEvents.push(payload as FileSystemWatchEventPayload);
    }
    if (channel === DESKTOP_IPC_CHANNELS.files.watchHealth) {
      this.healthEvents.push(payload as WatcherHealthEvent);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  on(event: string, listener: () => void): void {
    this.addListener(event, listener, false);
  }

  once(event: string, listener: () => void): void {
    this.addListener(event, listener, true);
  }

  removeListener(event: string, listener: () => void): void {
    const entries = this.listeners.get(event);
    if (!entries) {
      return;
    }
    const next = entries.filter((entry) => entry.listener !== listener);
    if (next.length === 0) {
      this.listeners.delete(event);
    } else {
      this.listeners.set(event, next);
    }
  }

  /** Test helper: live listener count for an event (leak detection). */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  private addListener(event: string, listener: () => void, once: boolean): void {
    const entries = this.listeners.get(event) ?? [];
    entries.push({ listener, once });
    this.listeners.set(event, entries);
  }

  private fire(event: string): void {
    // Snapshot before firing — a reap listener may mutate the map mid-iteration.
    const entries = [...(this.listeners.get(event) ?? [])];
    for (const entry of entries) {
      if (entry.once) {
        this.removeListener(event, entry.listener);
      }
      entry.listener();
    }
  }

  /** Test helper: simulate the renderer being destroyed. */
  fireDestroyed(): void {
    this.destroyed = true;
    this.fire('destroyed');
  }

  /** Test helper: simulate a renderer crash (WebContents survives). */
  fireRenderProcessGone(): void {
    this.fire('render-process-gone');
  }

  /** Test helper: simulate a main-frame navigation/reload. */
  fireDidNavigate(): void {
    this.fire('did-navigate');
  }
}

export const TEARDOWN_EVENTS = ['destroyed', 'render-process-gone', 'did-navigate'] as const;

export function totalTeardownListeners(owner: FakeWebContents): number {
  return TEARDOWN_EVENTS.reduce((sum, event) => sum + owner.listenerCount(event), 0);
}

export function invokeEventFor(owner: FakeWebContents): IpcMainInvokeEvent {
  trackTestWindowRole(owner.id, 'visible-ui');
  return {
    sender: owner as unknown as WebContents,
    senderFrame: createAllowlistedSenderFrame('visible-ui'),
  } as IpcMainInvokeEvent;
}

export function toDirectoryHandle(directoryPath: string) {
  return {
    kind: 'directory' as const,
    name: path.basename(directoryPath),
    path: directoryPath,
    platform: 'electron' as const,
  };
}
