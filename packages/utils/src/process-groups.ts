/**
 * The POSIX process groups this process started as their leaders: commands that can outlive
 * it, since a kill of this process never reaches another group. The desktop agent host reports
 * each one to Electron Main, which kills every group still listed once the host has exited,
 * however it exited (ADR-0031). On Windows a kill-on-close Job ends them instead.
 */
export interface ProcessGroupEvent {
  readonly pgid: number;
  readonly state: 'ended' | 'started';
}

const listeners = new Set<(event: ProcessGroupEvent) => void>();

/** Reports a group this process just started; the returned call reports that the group is gone. */
export function trackProcessGroup(pgid: number): () => void {
  for (const listener of listeners) {
    listener({ pgid, state: 'started' });
  }
  let ended = false;
  return () => {
    if (ended) {
      return;
    }
    ended = true;
    for (const listener of listeners) {
      listener({ pgid, state: 'ended' });
    }
  };
}

/** Receives every group reported from now on; the returned call stops it. */
export function onProcessGroup(listener: (event: ProcessGroupEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tracks a child spawned as the leader of its own group. A finite command's group ends with its
 * leader: at the leader's exit every member left is SIGKILLed, and only then is the group reported
 * ended, so a member that ignores SIGTERM or holds the leader's pipes never outlives it unlisted.
 * A member this process may not signal (EPERM: a setuid program) keeps the group listed, for Main
 * to kill once the host has exited.
 */
export function trackChildProcessGroup(child: {
  once(event: 'exit', listener: () => void): unknown;
  readonly pid?: number | undefined;
}): void {
  const pgid = child.pid;
  if (pgid === undefined) {
    return;
  }
  const ended = trackProcessGroup(pgid);
  child.once('exit', () => {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return;
      }
    }
    ended();
  });
}
