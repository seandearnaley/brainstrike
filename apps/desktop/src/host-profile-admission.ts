import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import type { HostAttachment } from '@brainstrike/host-lease';
import type { DesktopProfileRuntime } from './desktop-profile-runtime';
import {
  isHostLeaseClosed,
  isRetirementRefusal,
  PROFILE_CLOSED_FOR_QUIT,
  PROFILE_CLOSED_FOR_RESET,
} from './desktop-shutdown-state';

export interface HostProfileAdmission {
  /** A borrow of the profile's host (a client's or Main's own): started, joined, or refused. */
  acquire(signal?: AbortSignal): Promise<HostAttachment>;
  /** Content clear: borrows close until `resume` reopens the profile the clear left. */
  clearAndRetireContent(): Promise<void>;
  /** Quit begins: every borrow still waiting for the host's start-up is refused now. */
  fenceTerminal(): void;
  /** A successful reset reopens the profile it left and admits borrows again. */
  resume(signal?: AbortSignal): Promise<void>;
  /** A factory reset or quit retires the profile; borrows close until `resume` reopens it. */
  retire(reason?: unknown): Promise<void>;
}

/**
 * Profile admission for the host's clients (catalog, Main's own client, visible clients). It is
 * the one place that decides to start another host: once, after the failed one's release is
 * joined, and only after a failure, which is the host's `failed` report or exit (lifecycle R2:
 * no clock fails a start).
 *
 * BST-2247: a borrow never waits out a start-up that quit has fenced. Quit's fence refuses
 * every borrow still waiting, with the terminal refusal, as the shutdown begins. The start-up
 * itself stays the profile owner's, which cancels it when the profile retires; a refused
 * borrower only stops waiting for it.
 *
 * A reset retires the profile and deletes its content; until it reopens the profile, a borrow
 * is refused rather than starting a host on a profile being deleted (ADR-0015).
 */
export function createHostProfileAdmission(
  profile: DesktopProfileRuntime<HostAttachment>
): HostProfileAdmission {
  const fenced = Promise.withResolvers<never>();
  fenced.promise.catch(() => undefined);
  let terminal = false;
  let closed = false;
  const assertOpen = (): void => {
    if (terminal) {
      throw new BoundaryFailureError(PROFILE_CLOSED_FOR_QUIT);
    }
    if (closed || profile.isRetiring()) {
      throw new BoundaryFailureError(PROFILE_CLOSED_FOR_RESET);
    }
  };
  const admit = async (signal?: AbortSignal): Promise<HostAttachment> => {
    const attach = async (): Promise<HostAttachment> => {
      const attachment = await profile.acquire(signal);
      assertOpen();
      return attachment;
    };
    // BST-2004: a lost ready host fails like a failed start; join its Root release first.
    await profile.retireFailed();
    assertOpen();
    try {
      return await attach();
    } catch (cause) {
      let recovered: boolean;
      try {
        recovered = await profile.retireFailed();
      } catch (release) {
        throw new AggregateError(
          [cause, release],
          'Host acquisition failed and its release failed'
        );
      }
      if (!recovered) {
        throw cause;
      }
      return await attach();
    }
  };
  const acquire = (signal?: AbortSignal): Promise<HostAttachment> => {
    if (terminal) {
      return fenced.promise;
    }
    try {
      assertOpen();
    } catch (refusal) {
      return Promise.reject(refusal);
    }
    return Promise.race([admit(signal), fenced.promise]);
  };
  return {
    acquire,
    clearAndRetireContent: () => {
      closed = true;
      return profile.clearAndRetireContent();
    },
    fenceTerminal: () => {
      if (!terminal) {
        terminal = true;
        fenced.reject(new BoundaryFailureError(PROFILE_CLOSED_FOR_QUIT));
      }
    },
    resume: async (signal) => {
      signal?.throwIfAborted();
      closed = false;
      await acquire(signal);
    },
    retire: (reason) => {
      closed = true;
      return profile.retire(Promise.resolve(), reason);
    },
  };
}

/** An aggregated failure's inner error as the log keeps it, nested errors and cause included. */
interface InnerError {
  readonly cause?: InnerError;
  readonly errors?: readonly InnerError[];
  readonly message: string;
  readonly name: string;
}

function innerError(error: unknown): InnerError {
  if (!(error instanceof Error)) {
    return { message: String(error), name: typeof error };
  }
  return {
    ...(error.cause === undefined ? {} : { cause: innerError(error.cause) }),
    ...(error instanceof AggregateError
      ? { errors: (error.errors as unknown[]).map(innerError) }
      : {}),
    message: error.message,
    name: error.name,
  };
}

interface StartupLogger {
  debug(message: string): void;
  error(message: string, details: { error: unknown; innerErrors?: readonly InnerError[] }): void;
  info(message: string, details: { reason: string }): void;
}

/**
 * BST-2118: the profile's boot acquisition. A close of its own lease owner cancels a startup
 * still in flight; that typed outcome is a cancellation, not a failure, as is quit's retirement.
 */
export function reportAgentHostStartupFailure(
  error: unknown,
  shuttingDown: boolean,
  logger: StartupLogger
): void {
  if (isHostLeaseClosed(error)) {
    logger.debug('Agent host startup cancelled: its lease owner closed');
    return;
  }
  if (shuttingDown && isRetirementRefusal(error)) {
    logger.info('Agent host startup retired during shutdown', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  // The logger serializes an AggregateError without its `errors`; each inner error is logged
  // with its name, message and cause.
  logger.error(
    'Agent host startup failed',
    error instanceof AggregateError
      ? { error, innerErrors: (error.errors as unknown[]).map(innerError) }
      : { error }
  );
}
