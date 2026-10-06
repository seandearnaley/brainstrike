import { NativeIndexBlockedError } from './native-index-blocked';
import { NativeIndexSetupRequiredError } from './native-index-setup-required';

/** Trusted main-owner evidence that a read crossed a routine authority transition. */
export class NativeAuthorityTransitionError extends Error {
  readonly code = 'native-authority-transition';

  constructor(message: string) {
    super(message);
    this.name = 'NativeAuthorityTransitionError';
  }
  /** A retained independent failure is never proof of a routine admission transition. */
  static closedAdmission(message: string, cause: unknown): Error {
    if (
      cause instanceof NativeIndexSetupRequiredError ||
      cause instanceof NativeIndexBlockedError
    ) {
      return cause;
    }
    if (cause !== undefined) {
      return new Error(message, { cause });
    }
    return new NativeAuthorityTransitionError(message);
  }
}
