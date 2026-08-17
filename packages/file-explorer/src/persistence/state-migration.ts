import { createLogger } from '@brainstrike/logging';
import { DEFAULT_STATE, type SerializedState } from '@brainstrike/types';
import { FILE_EXPLORER_STORAGE_VERSION } from './persistence-constants';

interface ZustandPersistWrapper<T> {
  state?: T;
  version?: number;
}

const logger = createLogger('Persistence');

function createEmptySerializedState(): SerializedState {
  return {
    activeRootIds: [],
    currentFolderId: null,
    devInlineFixtureEnabled: DEFAULT_STATE.devInlineFixtureEnabled,
    excludeFilters: [...DEFAULT_STATE.excludeFilters],
    expandedDirectoryPaths: [],
    folderAccessOrder: [...DEFAULT_STATE.folderAccessOrder],
    folderStates: {},
    folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
    includeFilters: [...DEFAULT_STATE.includeFilters],
    includeProjectTree: DEFAULT_STATE.includeProjectTree,
    isFilterChipsVisible: DEFAULT_STATE.isFilterChipsVisible,
    isFiltersExpanded: DEFAULT_STATE.isFiltersExpanded,
    lastActiveTab: DEFAULT_STATE.lastActiveTab,
    maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
    quickFilter: DEFAULT_STATE.quickFilter,
    rootDescriptors: {},
    selectedFilePaths: [],
    selectionModel: {
      explicitPaths: [],
      materializedAt: DEFAULT_STATE.selectionModel.materializedAt,
      materializedPaths: null,
      mode: DEFAULT_STATE.selectionModel.mode,
      queryDescriptor: null,
    },
    tokenBudget: DEFAULT_STATE.tokenBudget,
    useRegex: DEFAULT_STATE.useRegex,
    viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function hasArrayContainer(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || isArray(value[key]);
}

function looksLikeSerializedFolderState(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasArrayContainer(value, 'excludeFilters') &&
    hasArrayContainer(value, 'expandedDirectoryPaths') &&
    hasArrayContainer(value, 'includeFilters') &&
    hasArrayContainer(value, 'selectedFilePaths')
  );
}

export function isSerializedStateCandidate(value: unknown): value is SerializedState {
  if (!isRecord(value)) {
    return false;
  }

  const candidate = value;
  const currentFolderId = candidate['currentFolderId'];
  const folderStates = candidate['folderStates'];
  return Boolean(
    (currentFolderId === null || typeof currentFolderId === 'string') &&
      isRecord(folderStates) &&
      isArray(candidate['folderAccessOrder']) &&
      isArray(candidate['selectedFilePaths']) &&
      isArray(candidate['expandedDirectoryPaths'])
  );
}

function discardInvalidPayload(
  message: string,
  shouldLog: boolean,
  onDiscard?: () => void
): SerializedState {
  onDiscard?.();
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
    valueType: rawPersistedState === null ? 'null' : typeof rawPersistedState,
    version,
    wrapperStatePresent:
      typeof rawPersistedState === 'object' &&
      rawPersistedState !== null &&
      'state' in (rawPersistedState as Record<string, unknown>),
  });
}

export function validateAndRecoverSerializedState(
  persistedState: unknown,
  shouldLog: boolean,
  onDiscard?: () => void
): SerializedState {
  if (!isSerializedStateCandidate(persistedState)) {
    return discardInvalidPayload(
      'Migrate - Payload does not match SerializedState shape, discarding.',
      shouldLog,
      onDiscard
    );
  }

  const folderStates = persistedState.folderStates ?? {};
  const validFolderStates = Object.fromEntries(
    Object.entries(folderStates).filter(([, folderState]) =>
      looksLikeSerializedFolderState(folderState)
    )
  );
  const droppedFolderStateCount =
    Object.keys(folderStates).length - Object.keys(validFolderStates).length;
  if (droppedFolderStateCount > 0) {
    onDiscard?.();
    if (shouldLog) {
      logger.debug('Migrate - Dropped malformed nested folder snapshots.', {
        droppedFolderStateCount,
      });
    }
    const droppedFolderIds = Object.keys(folderStates).filter(
      (folderId) => !(folderId in validFolderStates)
    );
    const droppedFolderIdSet = new Set(droppedFolderIds);
    return {
      ...persistedState,
      currentFolderId:
        persistedState.currentFolderId && droppedFolderIdSet.has(persistedState.currentFolderId)
          ? null
          : persistedState.currentFolderId,
      folderAccessOrder: persistedState.folderAccessOrder.filter(
        (folderId) => !droppedFolderIdSet.has(folderId)
      ),
      folderStates: validFolderStates,
    };
  }

  if (shouldLog) {
    logger.debug('Migrate - Returning valid SerializedState summary', {
      folderStateCount: Object.keys(folderStates).length,
      hasCurrentFolder: persistedState.currentFolderId !== null,
      hasSelectionModel: Boolean(persistedState.selectionModel),
      selectedFileCount: persistedState.selectedFilePaths.length,
    });
  }
  return persistedState;
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
    wrapper.state === undefined ? (rawPersistedState as SerializedState) : wrapper.state;

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
  shouldLog: boolean,
  onDiscard?: () => void
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
      shouldLog,
      onDiscard
    );
  }

  if (version > FILE_EXPLORER_STORAGE_VERSION) {
    return discardInvalidPayload(
      `Migrate - Future persisted version ${version} is not supported, discarding.`,
      shouldLog,
      onDiscard
    );
  }
  if (version < FILE_EXPLORER_STORAGE_VERSION) {
    return discardInvalidPayload(
      `Migrate - Persisted version ${version} is older than supported version ${FILE_EXPLORER_STORAGE_VERSION}, discarding.`,
      shouldLog
    );
  }
  return validateAndRecoverSerializedState(stateToProcess, shouldLog, onDiscard);
}
