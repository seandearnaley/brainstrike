import { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';

export { NativeIndexRefusalError } from '@brainstrike/indexing-contract/indexer-client';

/** A valid but incomplete user choice, not a failed index operation. */
export class NativeIndexSetupRequiredError extends NativeIndexRefusalError {
  constructor(message: string) {
    super({ kind: 'setup-required', message }, message);
    this.name = 'NativeIndexSetupRequiredError';
  }
}

/** A resource borrow crossed the lifecycle's generation boundary. */
export class NativeAuthorityTransitionError extends NativeIndexRefusalError {
  constructor(message: string) {
    super({ kind: 'transitioning' }, message);
    this.name = 'NativeAuthorityTransitionError';
  }
}

export const NATIVE_COVERAGE_OBSERVATION_INVALIDATED = 'native-coverage-observation-invalidated';
