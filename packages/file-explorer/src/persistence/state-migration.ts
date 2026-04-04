import { DEFAULT_STATE, type SerializedState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';

interface ZustandPersistWrapper<T> {
  state?: T;
  version?: number;
}

const logger = createLogger('Persistence');

function createEmptySerializedState(): SerializedState {
  return {
    currentFolderId: null,
    devInlineFixtureEnabled: DEFAULT_STATE.devInlineFixtureEnabled,
    excludeFilters: [...DEFAULT_STATE.excludeFilters],
    expandedDirectoryPaths: [],
    folderAccessOrder: [...DEFAULT_STATE.folderAccessOrder],
    folderStates: {},
    folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
    includeFilters: [...DEFAULT_STATE.includeFilters],
    includeProjectTree: DEFAULT_STATE.includeProjectTree,
    isFiltersExpanded: DEFAULT_STATE.isFiltersExpanded,
    lastActiveTab: DEFAULT_STATE.lastActiveTab,
    maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
    quickFilter: DEFAULT_STATE.quickFilter,
    selectedFilePaths: [],
    selectionModel: {
      mode: DEFAULT_STATE.selectionModel.mode,
      explicitPaths: [],
      materializedAt: DEFAULT_STATE.selectionModel.materializedAt,
      materializedPaths: null,
      queryDescriptor: null,
      ruleSetJson: DEFAULT_STATE.selectionModel.ruleSetJson,
    },
    tokenBudget: DEFAULT_STATE.tokenBudget,
    useRegex: DEFAULT_STATE.useRegex,
    viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
  };
}

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

function discardInvalidPayload(message: string, shouldLog: boolean): SerializedState {
  if (shouldLog) {
    logger.debug(message);
  }
  return createEmptySerializedState();
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
    return createEmptySerializedState();
  }

  if (typeof rawPersistedState !== 'object') {
    return discardInvalidPayload(
      'Migrate - Invalid non-object persisted payload, discarding.',
      shouldLog
    );
  }

  const wrapper = rawPersistedState as Partial<ZustandPersistWrapper<SerializedState>>;
  if ('state' in wrapper && wrapper.state === undefined) {
    return discardInvalidPayload('Migrate - Wrapped state missing payload, discarding.', shouldLog);
  }
  const stateToProcess =
    wrapper.state !== undefined ? wrapper.state : (rawPersistedState as SerializedState);

  if (stateToProcess === null || stateToProcess === undefined) {
    if (shouldLog) {
      logger.debug('Migrate - No actual state after unwrap (null/undefined), returning as is.');
    }
    return createEmptySerializedState();
  }

  if (!looksLikeSerializedState(stateToProcess)) {
    return discardInvalidPayload(
      'Migrate - Payload does not match SerializedState shape, discarding.',
      shouldLog
    );
  }

  const serialized = stateToProcess as SerializedState;
  const migrated = version < 2 ? ensureSelectionModel(serialized) : serialized;
  if (shouldLog) {
    logger.debug('Migrate - Returning valid SerializedState:', migrated);
  }
  return migrated;
}
