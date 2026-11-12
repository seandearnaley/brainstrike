import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import type { ProfileResetLease } from '@brainstrike/host-lease';
import { RootLock } from '@brainstrike/state-store';
import type { WorktreeResetOutcome } from '@brainstrike/types';
import { disposeActiveBrowserPaneViews } from './browser/browser-pane-host';
import { clearDesktopBrowserSessions } from './browser/browser-session';
import {
  type ResetDesktopApplicationDataOptions,
  resetDesktopApplicationData,
} from './desktop-factory-reset';
import { isQuitTerminalRefusal, RESET_REOPEN_CANCELLED } from './desktop-shutdown-state';

interface DesktopResetRuntime {
  readonly name: string;
  readonly stop: () => Promise<unknown>;
  /** Stop admission without deleting configuration retained by content clearing. */
  readonly stopForContent?: () => Promise<unknown>;
}

interface DesktopResetLogger {
  readonly debug: (message: string, error: unknown) => void;
  readonly error: (message: string, error: unknown) => void;
  readonly info: (message: string) => void;
}

/** A factory reset wipes everything; a content clear keeps configuration. */
export type DesktopResetMode = 'factory' | 'content';

export interface CreateDesktopFactoryResetHandlerOptions {
  /**
   * ADR-0034: Factory Reset archives every managed worktree through the host before it deletes
   * the state DB that holds their ledger. Clear Database keeps them and does not call it.
   */
  readonly archiveManagedWorktrees?: ResetDesktopApplicationDataOptions['archiveManagedWorktrees'];
  /** Terminal clear through the current host writer; retains configuration in place. */
  readonly clearRetainedContent?: () => Promise<void>;
  /** Replaces the stale visible renderer and resolves only after its explicit
   * renderer-ready acknowledgement. A factory reset also clears the renderer's
   * session storage between the old document and the new one. MCP admission
   * remains closed while this promise is pending. Terminal quit cancels
   * readiness through the signal. */
  readonly completeSuccessfulReset: (signal: AbortSignal, mode: DesktopResetMode) => Promise<void>;
  /** Crashpad's live database; reset keeps it in place and deletes its reports. */
  readonly crashDumpsPath?: string;
  /** Every on-disk path the durable NDJSON error-log backstop (Flight
   * Recorder P2a) can occupy — forwarded to `resetDesktopApplicationData` so
   * factory reset purges it alongside the database, even though it lives
   * outside `userDataPath` and inside the otherwise-preserved `logs` folder. */
  readonly errorLogFilePaths?: readonly string[];
  readonly logger: DesktopResetLogger;
  readonly prepareDatabaseProfileReset: () => Promise<ProfileResetLease>;
  readonly resetLocalDatabase: (lease?: ProfileResetLease) => Promise<void>;
  readonly resumeAfterReset?: (
    outcome: 'failed' | 'succeeded',
    signal: AbortSignal
  ) => Promise<void>;
  readonly runtimes: readonly DesktopResetRuntime[];
  /** Electron owns this dedicated container; clear its sessions before purge. */
  readonly sessionDataPath: string;
  readonly userDataPath: string;
}

export interface DesktopFactoryResetResult {
  /** ADR-0034: what a Factory Reset did with the managed worktrees, when it got that far. */
  managedWorktrees?: WorktreeResetOutcome;
  message?: string;
  success: boolean;
}

export interface DesktopFactoryReset {
  clearContent(): Promise<DesktopFactoryResetResult>;
  /** Joins accepted deletion with its original failure, cancels replacement
   * startup and refuses new resets. */
  close(): Promise<void>;
  /**
   * Settles once no reset is in flight, its reopen included. A reset retires the
   * profile only until it reopens it: whoever needs the profile meanwhile waits.
   */
  idle(): Promise<void>;
  /** The accepted reset, including its reopen or original failed outcome. */
  inFlight(): Promise<DesktopFactoryResetResult> | null;
  reset(): Promise<DesktopFactoryResetResult>;
  /**
   * The last Factory Reset's managed worktrees, once. The window that asked for the reset is
   * replaced before the reset answers it, so the replacement window takes this as it starts.
   */
  takeWorktreeOutcome(): WorktreeResetOutcome | null;
}

type ResetFailure =
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'none' };

const NO_RESET_FAILURE: ResetFailure = { kind: 'none' };

function combineResetFailure(failure: unknown, resumeFailure: unknown): unknown {
  const resetMessage = failure instanceof Error ? failure.message : String(failure);
  const resumeMessage =
    resumeFailure instanceof Error ? resumeFailure.message : String(resumeFailure);
  return new AggregateError(
    [failure, resumeFailure],
    `${resetMessage}; reset runtime resume failed: ${resumeMessage}`
  );
}

async function resumeDesktopResetRuntime({
  failure,
  logger,
  rendererReplacementSucceeded,
  resetDataSucceeded,
  resumeAfterReset,
  signal,
}: {
  signal: AbortSignal;
  failure: ResetFailure;
  logger: DesktopResetLogger;
  rendererReplacementSucceeded: boolean;
  resetDataSucceeded: boolean;
  resumeAfterReset: CreateDesktopFactoryResetHandlerOptions['resumeAfterReset'];
}): Promise<ResetFailure> {
  if (signal.aborted || (resetDataSucceeded && !rendererReplacementSucceeded)) {
    return failure;
  }
  try {
    await resumeAfterReset?.(resetDataSucceeded ? 'succeeded' : 'failed', signal);
    return failure;
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      return failure;
    }
    // BST-2278: quit fences profile admission before its factory-reset step cancels this
    // reopen, so a reopen that borrows the profile meanwhile gets quit's one terminal
    // refusal (ADR-0026). The deletion is complete; quit retires what this would reopen.
    if (resetDataSucceeded && isQuitTerminalRefusal(error)) {
      logger.debug('Factory reset complete; resume skipped because the app is quitting', error);
      return failure;
    }
    return {
      error: failure.kind === 'none' ? error : combineResetFailure(failure.error, error),
      kind: 'failed',
    };
  }
}

async function stopDesktopResetRuntimes(
  runtimes: readonly DesktopResetRuntime[],
  mode: DesktopResetMode = 'factory'
): Promise<void> {
  const results = await Promise.allSettled(
    runtimes.map((runtime) =>
      mode === 'content' && runtime.stopForContent ? runtime.stopForContent() : runtime.stop()
    )
  );
  const failures = results
    .map((result, index) => ({ result, runtime: runtimes[index] }))
    .filter(
      (entry): entry is { result: PromiseRejectedResult; runtime: DesktopResetRuntime } =>
        entry.result.status === 'rejected'
    );
  if (failures.length === 0) {
    return;
  }
  const failedNames = failures.map(({ runtime }) => runtime.name).join(', ');
  throw new AggregateError(
    failures.map(({ result }) => result.reason),
    `Failed to stop desktop reset runtimes: ${failedNames}`
  );
}

export function createDesktopFactoryResetHandler({
  archiveManagedWorktrees,
  clearRetainedContent,
  completeSuccessfulReset,
  crashDumpsPath,
  errorLogFilePaths,
  logger,
  prepareDatabaseProfileReset,
  resetLocalDatabase,
  resumeAfterReset,
  runtimes,
  sessionDataPath,
  userDataPath,
}: CreateDesktopFactoryResetHandlerOptions): DesktopFactoryReset {
  const shutdown = new AbortController();
  let profileResetLease: ProfileResetLease | null = null;
  // ADR-0034: kept for the replacement window, which takes it once.
  let untakenWorktreeOutcome: WorktreeResetOutcome | null = null;
  /** Deletes what `mode` deletes; a Factory Reset answers with its managed worktrees. */
  const resetData = async (mode: DesktopResetMode): Promise<WorktreeResetOutcome | undefined> => {
    if (mode === 'content') {
      if (!clearRetainedContent) {
        throw new Error('Content clearing is unavailable.');
      }
      await stopDesktopResetRuntimes(runtimes, 'content');
      await clearRetainedContent();
      return;
    }
    const { managedWorktrees } = await resetDesktopApplicationData({
      ...(archiveManagedWorktrees === undefined ? {} : { archiveManagedWorktrees }),
      ...(crashDumpsPath === undefined ? {} : { crashDumpsPath }),
      ...(errorLogFilePaths === undefined ? {} : { errorLogFilePaths }),
      getProtectedPaths: () => {
        if (!profileResetLease || profileResetLease.isReleased) {
          throw new Error('Desktop factory reset requires an owned profile reset lease');
        }
        return [RootLock.dirOf(profileResetLease.root), sessionDataPath];
      },
      resetDatabaseProfile: async () => {
        profileResetLease ??= await prepareDatabaseProfileReset();
        await resetLocalDatabase(profileResetLease);
      },
      stopBackgroundRuntimes: async () => {
        await stopDesktopResetRuntimes(runtimes);
        // Browser pane (BST-1174). Order matters: CLOSE the live
        // `WebContentsView`s first, THEN clear the partition. A still-running
        // view can rewrite cookies/localStorage into `persist:browser-pane`
        // between the clear and the reset's reload, leaving site state behind
        // (codex P1) — disposing the views makes the storage quiescent before
        // we wipe it. Electron owns the live session container; its API
        // clears both sessions without renaming Chromium's locked files.
        disposeActiveBrowserPaneViews();
        await clearDesktopBrowserSessions();
      },
      userDataPath,
    });
    untakenWorktreeOutcome = managedWorktrees ?? null;
    return managedWorktrees;
  };
  const runReset = async (mode: DesktopResetMode): Promise<DesktopFactoryResetResult> => {
    let failure: ResetFailure = NO_RESET_FAILURE;
    let resetDataSucceeded = false;
    let rendererReplacementSucceeded = false;
    let managedWorktrees: WorktreeResetOutcome | undefined;
    try {
      managedWorktrees = await resetData(mode);
      resetDataSucceeded = true;
      profileResetLease?.release();
      profileResetLease = null;
      if (!shutdown.signal.aborted) {
        await completeSuccessfulReset(shutdown.signal, mode);
        rendererReplacementSucceeded = !shutdown.signal.aborted;
      }
    } catch (error) {
      failure = { error, kind: 'failed' };
    }

    // While continuing the app, a failed purge restores its runtime snapshot. A successful
    // purge may reopen only after the replacement renderer explicitly reports
    // ready. Terminal quit never reopens; unrelated failures stay visible.
    failure = await resumeDesktopResetRuntime({
      failure,
      logger,
      rendererReplacementSucceeded,
      resetDataSucceeded,
      resumeAfterReset,
      signal: shutdown.signal,
    });
    if (failure.kind === 'failed') {
      logger.error('Failed to reset desktop application data:', failure.error);
      throw failure.error;
    }

    logger.info(
      mode === 'factory' ? 'Desktop factory reset completed' : 'Desktop content clear completed'
    );
    return { ...(managedWorktrees === undefined ? {} : { managedWorktrees }), success: true };
  };
  let resetInFlight: {
    readonly mode: DesktopResetMode;
    readonly completion: Promise<DesktopFactoryResetResult>;
    readonly result: Promise<DesktopFactoryResetResult>;
  } | null = null;
  const startReset = (mode: DesktopResetMode): Promise<DesktopFactoryResetResult> => {
    if (shutdown.signal.aborted) {
      return Promise.resolve({
        message: 'The app is quitting: the factory reset did not start.',
        success: false,
      });
    }
    if (resetInFlight) {
      return resetInFlight.mode === mode
        ? resetInFlight.result
        : resetInFlight.result.then(() => startReset(mode));
    }
    const completion = runReset(mode);
    // Only the renderer boundary converts an accepted reset's rejection to a
    // result envelope. Terminal close must join its original completion.
    const result = completion
      .catch(
        (error: unknown): DesktopFactoryResetResult => ({
          message: error instanceof Error ? error.message : String(error),
          success: false,
        })
      )
      .finally(() => {
        resetInFlight = null;
      });
    resetInFlight = { completion, mode, result };
    return result;
  };
  return {
    clearContent: () => startReset('content'),
    // Quit joins accepted deletion but cancels replacement readiness/startup.
    // The same signal fences subsequent reset requests; purge never observes it.
    close: async () => {
      shutdown.abort(new BoundaryFailureError(RESET_REOPEN_CANCELLED));
      await resetInFlight?.completion;
    },
    idle: async () => {
      while (resetInFlight) {
        await resetInFlight.result;
      }
    },
    inFlight: () => resetInFlight?.result ?? null,
    reset: () => startReset('factory'),
    takeWorktreeOutcome: () => {
      const outcome = untakenWorktreeOutcome;
      untakenWorktreeOutcome = null;
      return outcome;
    },
  };
}
