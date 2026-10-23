import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
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

/** A workspace search with no folder to search, in the words the workspace tools already use. */
export const NATIVE_SEARCH_NO_FOLDERS = refusal({
  category: 'input',
  code: 'native-search.no-folders',
  message: 'No folder is open in the workspace.',
  remedy: 'Add a folder in the left file tree first.',
});
