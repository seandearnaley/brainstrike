/** A valid but incomplete user choice, not a failed index operation. */
export class NativeIndexSetupRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeIndexSetupRequiredError';
  }
}

/** Trusted activation-owner evidence of a retained failure, never a fresh read failure. */
export class NativeIndexBlockedError extends Error {
  readonly code = 'native-index-blocked';

  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Native indexing is blocked: ${reason} Open Diagnostics for details.`, { cause });
    this.name = 'NativeIndexBlockedError';
  }
}

/** Preserve setup and independent cleanup failures at the trusted retained-failure seam. */
export function retainedNativeIndexFailure(cause: unknown): Error {
  if (cause instanceof AggregateError || cause instanceof NativeIndexSetupRequiredError) {
    return cause;
  }
  return new NativeIndexBlockedError(cause);
}

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

export const NATIVE_COVERAGE_OBSERVATION_INVALIDATED = 'native-coverage-observation-invalidated';

/** The admitted coverage observation lost its source/readiness fence; it contains no result. */
export class NativeCoverageObservationInvalidatedError extends Error {
  readonly code = NATIVE_COVERAGE_OBSERVATION_INVALIDATED;

  constructor() {
    super('Native source or saved profile changed during search.');
    this.name = 'NativeCoverageObservationInvalidatedError';
  }
}

/** Only an already-admitted borrow can prove that its own runtime retired its authority. */
export class NativeReadAuthorityRetiredError extends Error {
  readonly code = 'native-read-authority-retired';

  constructor() {
    super('Native read admission is closed.');
    this.name = 'NativeReadAuthorityRetiredError';
  }
}
