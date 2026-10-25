import { joinProcessExit as joinOsExit, processStartTime } from '@brainstrike/state-store';

/** A process's OS identity: its pid and the start time read while it was live. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly start: string;
}

/** The identity of `pid` if it is live now; undefined once it has exited (it has no start time). */
export function liveProcessIdentity(pid: number | undefined): ProcessIdentity | undefined {
  const start = pid === undefined ? null : processStartTime(pid);
  return pid === undefined || start === null ? undefined : { pid, start };
}

/**
 * Electron emits a utility's `exit` as soon as its Node service reports `process.exit()`
 * (the pipe's "process_exit_termination" reason), before Node's teardown and the OS exit
 * have run: on a loaded Windows machine the process is measurably still running then.
 * Main never holds the utility's process handle, so an owner joins its real exit by the
 * identity it read while the utility was live: on Windows a handle opened by that identity,
 * which the OS signals at the exit; on POSIX the identity itself, until it is gone.
 */
export async function joinProcessExit(identity: ProcessIdentity | undefined): Promise<void> {
  if (identity) {
    await joinOsExit(identity.pid, identity.start);
  }
}

/**
 * Ends what remains of a utility after Electron reported its exit, then joins its OS exit.
 * The utility has already reported `process.exit()`; a Node teardown that has not finished
 * (seen on hosted Windows: an indexer still running well after Stop released its Root) is
 * terminated by the identity read while it was live, so nothing outlives its owner's close.
 */
export async function endExitedProcess(identity: ProcessIdentity | undefined): Promise<void> {
  if (identity && processStartTime(identity.pid) === identity.start) {
    try {
      process.kill(identity.pid);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw cause;
      }
    }
  }
  await joinProcessExit(identity);
}
