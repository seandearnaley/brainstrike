import type { SerializedState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';

interface ZustandPersistWrapper<T> {
  state?: T;
  version?: number;
}

const logger = createLogger('Persistence');

function looksLikeSerializedState(value: unknown): value is SerializedState {
  if (!(value && typeof value === 'object')) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    'folderStates' in candidate ||
    'selectedFilePaths' in candidate ||
    'expandedDirectoryPaths' in candidate ||
    'currentFolderId' in candidate
  );
}

function ensureSelectionModel(state: SerializedState): SerializedState {
  const topLevelSelectionModel = state.selectionModel ?? {
    mode: 'explicit',
    explicitPaths: Array.isArray(state.selectedFilePaths) ? state.selectedFilePaths : [],
    ruleSetJson: null,
    materializedPaths: null,
    materializedAt: null,
    queryDescriptor: null,
  };

  return {
    ...state,
    selectionModel: topLevelSelectionModel,
    folderStates: Object.fromEntries(
      Object.entries(state.folderStates ?? {}).map(([folderId, folderState]) => [
        folderId,
        {
          ...folderState,
          selectionModel: folderState.selectionModel ?? {
            mode: 'explicit',
            explicitPaths: Array.isArray(folderState.selectedFilePaths)
              ? folderState.selectedFilePaths
              : [],
            ruleSetJson: null,
            materializedPaths: null,
            materializedAt: null,
            queryDescriptor: null,
          },
        },
      ])
    ),
  };
}

export function migrateState(
  rawPersistedState: unknown,
  version: number,
  shouldLog: boolean
): SerializedState {
  if (shouldLog) {
    logger.debug('Migrate - Received raw state:', rawPersistedState, 'Version:', version);
  }

  if (rawPersistedState === null || rawPersistedState === undefined) {
    if (shouldLog) {
      logger.debug('Migrate - No state (null or undefined), returning it as is.');
    }
    return rawPersistedState as unknown as SerializedState;
  }

  const wrapper = rawPersistedState as Partial<ZustandPersistWrapper<SerializedState>>;
  if ('state' in wrapper && wrapper.state === undefined) {
    return rawPersistedState as SerializedState;
  }
  const stateToProcess =
    wrapper.state !== undefined ? wrapper.state : (rawPersistedState as SerializedState);

  if (stateToProcess === null || stateToProcess === undefined) {
    if (shouldLog) {
      logger.debug('Migrate - No actual state after unwrap (null/undefined), returning as is.');
    }
    return stateToProcess as unknown as SerializedState;
  }

  if (!looksLikeSerializedState(stateToProcess)) {
    return stateToProcess as SerializedState;
  }

  const serialized = stateToProcess as SerializedState;
  const migrated = version < 2 ? ensureSelectionModel(serialized) : serialized;
  if (shouldLog) {
    logger.debug('Migrate - Returning valid SerializedState:', migrated);
  }
  return migrated;
}
