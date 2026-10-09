/**
 * ADR-0017: desktop Main supervises the native processes its agent host starts.
 * The host reports each one (pid, start time, whether it leads its own process
 * group) over the platform connection. If the utility dies, Main ends them with
 * the executor's own tail: SIGTERM now, SIGKILL after its grace. The lease close
 * then joins whatever it signalled and requires the Root's flock to be free, so
 * a surviving process keeps the close failed and the Root refused.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import type { NativeChild } from '@brainstrike/state-store/native-children';
import { KILL_GRACE_MS } from '../assistant-server/kill-grace';

export interface HostNativeChildren {
  /** Lease close: SIGKILL what remains, join it, then require the Root's flock free (POSIX). */
  close(): Promise<void>;
  exited(child: NativeChild): void;
  /** The host exited unexpectedly: SIGTERM every live group now, SIGKILL what remains after the grace. */
  retire(): void;
  started(child: NativeChild): void;
}

/** How often the close re-checks processes it has already SIGKILLed; its caller bounds the wait. */
const JOIN_POLL_MS = 25;

const gone = (cause: unknown, child: NativeChild): boolean => {
  const code = (cause as NodeJS.ErrnoException).code;
  // EPERM on a group: Darwin's killpg counts only unreaped zombies there.
  return code === 'ESRCH' || (child.group && code === 'EPERM');
};

/** Signals the process, or its whole group, unless its pid was reused or nothing of it is left. */
function signal(child: NativeChild, name: NodeJS.Signals): void {
  const leader = processStartTime(child.pid);
  if (leader === null ? !child.group : leader !== child.start) {
    return;
  }
  try {
    process.kill(child.group ? -child.pid : child.pid, name);
  } catch (cause) {
    if (!gone(cause, child)) {
      throw cause;
    }
  }
}

function remains(child: NativeChild): boolean {
  if (!child.group) {
    return processStartTime(child.pid) === child.start;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (cause) {
    if (gone(cause, child)) {
      return false;
    }
    throw cause;
  }
}

export function createHostNativeChildren(root: string): HostNativeChildren {
  const children = new Map<string, NativeChild>();
  const key = (child: NativeChild): string => `${child.pid}:${child.start}`;
  let grace: NodeJS.Timeout | undefined;
  return {
    close: async () => {
      clearTimeout(grace);
      const signalled = [...children.values()];
      for (const child of signalled) {
        signal(child, 'SIGKILL');
      }
      while (signalled.some(remains)) {
        await delay(JOIN_POLL_MS, undefined, { ref: false });
      }
      children.clear();
      if (process.platform !== 'win32' && RootLock.isFlockHeld(root)) {
        throw new Error(`The Root ${root} is still held by a native process its host started`);
      }
    },
    exited: (child) => {
      children.delete(key(child));
    },
    retire: () => {
      for (const child of children.values()) {
        signal(child, 'SIGTERM');
      }
      grace ??= setTimeout(() => {
        for (const child of children.values()) {
          signal(child, 'SIGKILL');
        }
      }, KILL_GRACE_MS);
      grace.unref();
    },
    started: (child) => {
      children.set(key(child), child);
    },
  };
}
