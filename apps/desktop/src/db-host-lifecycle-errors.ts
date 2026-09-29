export type DbHostCloseOutcome =
  /** The host reported that closing the database failed; it was then SIGKILLed. */
  | 'close-failed'
  /** The host exited with a non-zero code before it acknowledged the close. */
  | 'exited-unclean'
  /** The host missed the close acknowledgement and SIGTERM, and only SIGKILL ended it. */
  | 'killed'
  /** The host was still running after every signal, so it may still own the data directory. */
  | 'exit-timeout';

/** `DbHostManager.close()` could not prove the database closed and the host is gone. */
export class DbHostCloseError extends Error {
  readonly exitCode: number | undefined;
  readonly outcome: DbHostCloseOutcome;

  constructor(
    outcome: DbHostCloseOutcome,
    message: string,
    options: { readonly cause?: unknown; readonly exitCode?: number | undefined } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DbHostCloseError';
    this.exitCode = options.exitCode;
    this.outcome = outcome;
  }
}

/** No DB host may be started right now; the caller must not expect a silent re-open. */
export class DbHostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbHostUnavailableError';
  }

  /**
   * The host closed itself on a signal aimed at it, not one main sent. A replacement would
   * silently re-open the database behind whoever signalled it, so nothing forks until restart.
   * `signal` is null when only the clean-shutdown marker proved it (the announcement was lost).
   */
  static closedBySignal(signal: string | null): DbHostUnavailableError {
    return new DbHostUnavailableError(
      `DB host is unavailable: it closed ${signal === null ? 'itself after a signal' : `after receiving ${signal}`}; restart BrainStrike.`
    );
  }
}
