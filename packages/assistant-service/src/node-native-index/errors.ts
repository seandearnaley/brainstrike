import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
import {
  NATIVE_SEARCH_FOLDER_NOT_INDEXED as FOLDER_NOT_INDEXED_CODE,
  NativeIndexRefusalError,
  NO_WORKSPACE_FOLDER_MESSAGE,
} from '@brainstrike/indexing-contract/indexer-client';

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

/** A workspace search with no folder to search, in the words the workspace tools use. */
export const NATIVE_SEARCH_NO_FOLDERS = refusal({
  category: 'input',
  code: 'native-search.no-folders',
  message: NO_WORKSPACE_FOLDER_MESSAGE,
});

/**
 * A search naming a folder the index does not serve: a worktree not opted in,
 * a folder removed or disconnected since, or one folder named twice.
 */
export const NATIVE_SEARCH_FOLDER_NOT_INDEXED = refusal({
  category: 'configuration',
  code: FOLDER_NOT_INDEXED_CODE,
  message: 'A folder in this search is not indexed or is no longer open.',
  remedy: 'Search again, and turn a worktree on in Settings, Search & Indexing to include it.',
});
