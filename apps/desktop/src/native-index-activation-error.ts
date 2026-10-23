import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import { isHostLeaseClosed, isRetirementRefusal } from './desktop-shutdown-state';
import { IndexerUtilityExitedError } from './indexer-utility-exit';
import { NativeAuthorityTransitionError } from './native-authority-transition';
import { indexConfigCause } from './native-index-boundary-failure';
import { NativeIndexSetupRequiredError } from './native-index-setup-required';
import { NativeIndexEventRefusedError } from './native-index-workflow-errors';

/** An aggregated failure's inner error as the log keeps it, nested errors and cause included. */
interface InnerError {
  readonly cause?: InnerError;
  readonly errors?: readonly InnerError[];
  readonly message: string;
  readonly name: string;
}

interface ActivationLogger {
  error(message: string, details: { error: unknown; innerErrors?: readonly InnerError[] }): void;
  info(message: string, details: { reason: string }): void;
}

function innerError(error: unknown): InnerError {
  // Canonical utility aborts are DOMExceptions, which are not always Error instances.
  if (error instanceof DOMException) {
    return { message: error.message, name: error.name };
  }
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

/**
 * A generation a newer one replaced (`transitioning`), or one an owner closed: reset, terminal
 * retirement, root-data deletion, profile retirement or shutdown (`closed`). Typed only by the
 * lifecycle owner, so a failure of the current generation or an untyped error never matches.
 */
function isReplacedOrRetiredGeneration(error: unknown): boolean {
  const kind =
    error instanceof NativeIndexRefusalError
      ? error.refusal.kind
      : error instanceof NativeIndexEventRefusedError
        ? error.cause.kind
        : undefined;
  return kind === 'transitioning' || kind === 'closed';
}

export function reportNativeIndexActivationError(
  message: string,
  error: unknown,
  shuttingDown: boolean,
  logger: ActivationLogger
): void {
  // A search index config read or apply wraps quit's retirement; the cause is what quit refused.
  const cause = indexConfigCause(error);
  if (shuttingDown && cause instanceof IndexerUtilityExitedError) {
    // A signal to Main's process group ends the utility with the shutdown (BST-2135). Info, not
    // warn: the exit cannot lose committed index state (see `IndexerUtilityExitedError`).
    logger.info('Native indexer utility exited before shutdown retired its attachments', {
      reason: cause.message,
    });
    return;
  }
  if (
    shuttingDown &&
    (cause instanceof NativeAuthorityTransitionError || isRetirementRefusal(cause))
  ) {
    logger.info('Native index activation retired during shutdown', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }
  if (isReplacedOrRetiredGeneration(cause)) {
    // The owner's requested outcome happened; the current generation reports its own state.
    logger.info('Native index generation replaced or retired', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }
  if (error instanceof NativeIndexSetupRequiredError) {
    logger.info('Workspace index setup required', { reason: error.message });
    return;
  }
  // The logger serializes an AggregateError without its `errors`, so a retirement
  // failure ("Canonical utility attachments did not retire.") would say nothing of
  // which close failed. Each inner error is logged with its name, message and cause.
  logger.error(
    message,
    error instanceof AggregateError
      ? { error, innerErrors: (error.errors as unknown[]).map(innerError) }
      : { error }
  );
}

/**
 * BST-2118: the profile's boot acquisition. A close of its own lease owner cancels
 * a startup still in flight; that typed outcome is a cancellation, not a failure.
 */
export function reportAgentHostStartupFailure(
  error: unknown,
  shuttingDown: boolean,
  logger: ActivationLogger & { debug(message: string): void }
): void {
  if (isHostLeaseClosed(error)) {
    logger.debug('Agent host startup cancelled: its lease owner closed');
    return;
  }
  reportNativeIndexActivationError('Agent host startup failed', error, shuttingDown, logger);
}
