import { isHostLeaseClosed, isRetirementRefusal } from './desktop-shutdown-state';
import { NativeAuthorityTransitionError } from './native-authority-transition';
import { NativeIndexSetupRequiredError } from './native-index-setup-required';

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

export function reportNativeIndexActivationError(
  message: string,
  error: unknown,
  shuttingDown: boolean,
  logger: ActivationLogger
): void {
  if (
    shuttingDown &&
    (error instanceof NativeAuthorityTransitionError || isRetirementRefusal(error))
  ) {
    logger.info('Native index activation retired during shutdown', {
      reason: error instanceof Error ? error.message : String(error),
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
