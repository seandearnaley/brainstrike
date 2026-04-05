import { DEFAULT_STATE, type SerializedState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';

interface ZustandPersistWrapper<T> {
  state?: T;
  version?: number;
}

const logger = createLogger('Persistence');
const CURRENT_STORAGE_VERSION = 2;

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
    (('folderStates' in candidate && typeof candidate['folderStates'] === 'object') ||
      ('selectedFilePaths' in candidate && Array.isArray(candidate['selectedFilePaths'])) ||
      ('expandedDirectoryPaths' in candidate &&
        Array.isArray(candidate['expandedDirectoryPaths']))) &&
    ('currentFolderId' in candidate || 'selectionModel' in candidate)
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

function logPersistedStateCandidate(
  rawPersistedState: unknown,
  version: number,
  shouldLog: boolean
): void {
  if (!shouldLog) {
    return;
  }

  logger.debug('Migrate - Received persisted state candidate', {
    version,
    wrapperStatePresent:
      typeof rawPersistedState === 'object' &&
      rawPersistedState !== null &&
      'state' in (rawPersistedState as Record<string, unknown>),
    valueType: rawPersistedState === null ? 'null' : typeof rawPersistedState,
  });
}

function unwrapPersistedState(
  rawPersistedState: unknown,
  shouldLog: boolean
): SerializedState | null | undefined | 'invalid' {
  if (rawPersistedState === null || rawPersistedState === undefined) {
    if (shouldLog) {
      logger.debug('Migrate - No state (null or undefined), returning it as is.');
    }
    return null;
  }

  if (typeof rawPersistedState !== 'object') {
    return 'invalid';
  }

  const wrapper = rawPersistedState as Partial<ZustandPersistWrapper<SerializedState>>;
  if ('state' in wrapper && wrapper.state === undefined) {
    return 'invalid';
  }

  const stateToProcess =
    wrapper.state !== undefined ? wrapper.state : (rawPersistedState as SerializedState);

  if (stateToProcess === null || stateToProcess === undefined) {
    if (shouldLog) {
      logger.debug('Migrate - No actual state after unwrap (null/undefined), returning as is.');
    }
    return null;
  }

  return stateToProcess;
}

export function migrateState(
  rawPersistedState: unknown,
  version: number,
  shouldLog: boolean
): SerializedState {
  logPersistedStateCandidate(rawPersistedState, version, shouldLog);
  const stateToProcess = unwrapPersistedState(rawPersistedState, shouldLog);
  if (stateToProcess === null || stateToProcess === undefined) {
    return createEmptySerializedState();
  }
  if (stateToProcess === 'invalid') {
    const isWrappedStateMissingPayload =
      typeof rawPersistedState === 'object' &&
      rawPersistedState !== null &&
      'state' in (rawPersistedState as Record<string, unknown>);
    return discardInvalidPayload(
      isWrappedStateMissingPayload
        ? 'Migrate - Wrapped state missing payload, discarding.'
        : 'Migrate - Invalid non-object persisted payload, discarding.',
      shouldLog
    );
  }

  if (!looksLikeSerializedState(stateToProcess)) {
    return discardInvalidPayload(
      'Migrate - Payload does not match SerializedState shape, discarding.',
      shouldLog
    );
  }

  const serialized = stateToProcess as SerializedState;
  if (version > CURRENT_STORAGE_VERSION) {
    return discardInvalidPayload(
      `Migrate - Future persisted version ${version} is not supported, discarding.`,
      shouldLog
    );
  }
  const migrated = version < 2 ? ensureSelectionModel(serialized) : serialized;
  if (shouldLog) {
    logger.debug('Migrate - Returning valid SerializedState summary', {
      currentFolderId: migrated.currentFolderId,
      folderStateCount: Object.keys(migrated.folderStates ?? {}).length,
      hasSelectionModel: Boolean(migrated.selectionModel),
      selectedFileCount: Array.isArray(migrated.selectedFilePaths)
        ? migrated.selectedFilePaths.length
        : 0,
    });
  }
  return migrated;
}
