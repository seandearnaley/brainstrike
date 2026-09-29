import { createLogger } from '@brainstrike/logging';
import type { UtilityProcess } from 'electron';
import {
  DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS,
  DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS,
} from './db-host-close-budget';
import { DbHostCloseError } from './db-host-lifecycle-errors';

const logger = createLogger('DbHostProcess');

/**
 * The DB host utility process plus what closing it needs: an `exit` promise whose
 * listener is registered at fork (no exit is missed) and SIGKILL, which Electron's
 * `kill()` (SIGTERM only) cannot deliver.
 */
export class DbHostProcess {
  readonly exited: Promise<number>;
  readonly handle: UtilityProcess;
  #exitCode: number | undefined;

  constructor(handle: UtilityProcess) {
    this.handle = handle;
    this.exited = new Promise<number>((resolve) => {
      handle.once('exit', (code) => {
        this.#exitCode = code;
        resolve(code);
      });
    });
  }

  /** `undefined` until the process has exited. */
  get exitCode(): number | undefined {
    return this.#exitCode;
  }

  /** SIGKILL by pid: a host stuck in synchronous WASM can run no handler, so only this always ends it. */
  forceKill(): void {
    const { pid } = this.handle; // undefined once the process is gone (or before it spawned)
    if (pid === undefined) {
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      // An already-gone process is fine (its exit event is what matters); anything else is not.
      if ((error as { code?: unknown } | null)?.code !== 'ESRCH') {
        throw error;
      }
    }
  }

  /** Resolves true when the process exited within `timeoutMs`, false while it is still running. */
  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exitCode !== undefined) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([this.exited.then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * SIGKILL and wait for the exit. A SIGKILL is a crash as far as the database is
 * concerned (WAL recovery runs on the next open; the missing clean-shutdown marker
 * records it), so it is always an error-level record. Resolves whether the process
 * was observed to exit.
 */
async function forceKillAndAwaitExit(
  host: DbHostProcess,
  context: Readonly<Record<string, unknown>>
): Promise<boolean> {
  host.forceKill();
  if (await host.waitForExit(DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS)) {
    logger.error('DB host terminated with SIGKILL', { ...context, exitCode: host.exitCode });
    return true;
  }
  logger.error('DB host did not exit after SIGKILL; it may still own the database', {
    ...context,
    pid: host.handle.pid,
    timeoutMs: DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS,
  });
  return false;
}

/** SIGKILLs a host that will never answer (a wedged statement); a failed kill is logged, not thrown. */
export async function killWedgedHost(
  host: DbHostProcess,
  context: Readonly<Record<string, unknown>>
): Promise<void> {
  try {
    await forceKillAndAwaitExit(host, context);
  } catch (error) {
    logger.error({ err: error, ...context }, 'DB host SIGKILL failed');
  }
}

/** How the wait for the host's close ended. */
type CloseAttempt =
  | { readonly kind: 'acked' }
  | { readonly kind: 'ack-failed'; readonly error: Error }
  | { readonly kind: 'ack-timeout' }
  | { readonly kind: 'exited'; readonly code: number };

async function awaitCloseAttempt(
  host: DbHostProcess,
  acknowledge: () => Promise<unknown>,
  ackTimeoutMs: number
): Promise<CloseAttempt> {
  const acknowledged = acknowledge().then(
    (): CloseAttempt => ({ kind: 'acked' }),
    (error: unknown): CloseAttempt =>
      // An exit rejects every pending request: that is the exit, not a failed close.
      host.exitCode === undefined
        ? { error: error instanceof Error ? error : new Error(String(error)), kind: 'ack-failed' }
        : { code: host.exitCode, kind: 'exited' }
  );
  const exited = host.exited.then((code): CloseAttempt => ({ code, kind: 'exited' }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<CloseAttempt>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'ack-timeout' }), ackTimeoutMs);
  });
  try {
    return await Promise.race([acknowledged, exited, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The database is closed, so any exit code is clean; SIGKILL only if the process lingers. */
async function stopAfterAcknowledgedClose(host: DbHostProcess): Promise<void> {
  host.handle.kill();
  if (await host.waitForExit(DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS)) {
    return;
  }
  if (await forceKillAndAwaitExit(host, { reason: 'exit-after-close-timeout' })) {
    return;
  }
  throw new DbHostCloseError(
    'exit-timeout',
    'DB host closed the database but did not exit after SIGTERM and SIGKILL.'
  );
}

/**
 * The host exited without acknowledging the close. The exit code is NEVER proof the database
 * closed: Electron reports 0 when `kill()` (SIGTERM) ends a host that has no signal handler.
 */
function unconfirmedExit(code: number | undefined, when: string): DbHostCloseError {
  return new DbHostCloseError(
    'exited-unclean',
    `DB host exited with code ${code} ${when}; the database was not confirmed closed.`,
    { exitCode: code }
  );
}

async function stopAfterAckTimeout(host: DbHostProcess, ackTimeoutMs: number): Promise<void> {
  logger.warn('DB host close acknowledgement timed out; asking the host to close now', {
    timeoutMs: ackTimeoutMs,
  });
  host.handle.kill();
  if (await host.waitForExit(DB_HOST_EXIT_AFTER_TERM_TIMEOUT_MS)) {
    throw unconfirmedExit(host.exitCode, 'after its close acknowledgement timed out');
  }
  const exited = await forceKillAndAwaitExit(host, { reason: 'close-ack-timeout' });
  throw new DbHostCloseError(
    exited ? 'killed' : 'exit-timeout',
    `DB host did not close within ${ackTimeoutMs}ms and ${exited ? 'was killed with SIGKILL' : 'did not exit after SIGTERM and SIGKILL'}; the database was not confirmed closed.`,
    { exitCode: host.exitCode }
  );
}

/**
 * The close ladder. `acknowledge` asks the host to close; `detach` runs once the wait
 * ends (the owner fails the host's requests and never forks a replacement from it).
 * Resolves only when the database is proven closed AND the process is gone; anything
 * else throws `DbHostCloseError`.
 *
 * - acknowledged: SIGTERM; any exit code is clean (the database is closed).
 * - exit before acknowledgement: unclean, whatever the exit code.
 * - acknowledgement timeout: SIGTERM, then unclean whatever the exit code; SIGKILL if it lingers.
 * - acknowledgement error (the close failed): SIGKILL.
 */
export async function closeDbHostProcess(
  host: DbHostProcess,
  options: {
    readonly ackTimeoutMs: number;
    readonly acknowledge: () => Promise<unknown>;
    readonly detach: () => void;
  }
): Promise<void> {
  const attempt = await awaitCloseAttempt(host, options.acknowledge, options.ackTimeoutMs);
  options.detach();
  if (attempt.kind === 'acked') {
    await stopAfterAcknowledgedClose(host);
    return;
  }
  if (attempt.kind === 'ack-timeout') {
    await stopAfterAckTimeout(host, options.ackTimeoutMs);
    return;
  }
  if (attempt.kind === 'exited') {
    throw unconfirmedExit(attempt.code, 'before it acknowledged the close');
  }
  const exited = await forceKillAndAwaitExit(host, { reason: 'close-failed' });
  throw new DbHostCloseError(
    exited ? 'close-failed' : 'exit-timeout',
    `DB host failed to close the database: ${attempt.error.message}`,
    { cause: attempt.error, exitCode: host.exitCode }
  );
}
