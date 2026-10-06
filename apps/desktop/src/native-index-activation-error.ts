import { NativeAuthorityTransitionError } from './native-authority-transition';
import { NativeIndexSetupRequiredError } from './native-index-setup-required';

interface ActivationLogger {
  error(message: string, details: { error: unknown }): void;
  info(message: string, details: { reason: string }): void;
}

export function reportNativeIndexActivationError(
  message: string,
  error: unknown,
  shuttingDown: boolean,
  logger: ActivationLogger
): void {
  if (shuttingDown && error instanceof NativeAuthorityTransitionError) {
    logger.info('Native index activation retired during shutdown', { reason: error.message });
    return;
  }
  if (error instanceof NativeIndexSetupRequiredError) {
    logger.info('Workspace index setup required', { reason: error.message });
    return;
  }
  logger.error(message, { error });
}
