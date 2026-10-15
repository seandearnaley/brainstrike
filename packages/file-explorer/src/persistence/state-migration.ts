import { createLogger } from '@brainstrike/logging';
import { DEFAULT_STATE, type SerializedState } from '@brainstrike/types';
import { decodeFileSelection } from '../selection.js';
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

function recoverSelectionKeys(
  value: unknown,
  scope: 'folder' | 'selection-model' | 'top-level',
  shouldLog: boolean,
  onDiscard?: () => void
): string[] {
  if (!isArray(value)) {
    if (value !== undefined) {
      onDiscard?.();
      if (shouldLog) {
        logger.debug('Migrate - Recovered malformed persisted selection key collection.', {
          scope,
        });
      }
    }
    return [];
  }

  const validKeys: string[] = [];
  let droppedKeyCount = 0;
  for (const key of value) {
    if (typeof key !== 'string') {
      droppedKeyCount += 1;
      continue;
    }
    try {
      decodeFileSelection(key);
      validKeys.push(key);
    } catch {
      droppedKeyCount += 1;
    }
  }

  if (droppedKeyCount > 0) {
    onDiscard?.();
    if (shouldLog) {
      logger.debug('Migrate - Recovered malformed persisted selection keys.', {
        droppedKeyCount,
        scope,
      });
    }
  }
  return validKeys;
}

function recoverSelectionModel(
  value: unknown,
  shouldLog: boolean,
  onDiscard?: () => void
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    ...value,
    explicitPaths: recoverSelectionKeys(
      value['explicitPaths'],
      'selection-model',
      shouldLog,
      onDiscard
    ),
  };
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

export function isSerializedStateCandidate(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const candidate = value;
  const currentFolderId = candidate['currentFolderId'];
  return (
    (currentFolderId === null || typeof currentFolderId === 'string') &&
    'folderStates' in candidate &&
    'folderAccessOrder' in candidate &&
    'selectedFilePaths' in candidate &&
    'expandedDirectoryPaths' in candidate
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

  const candidate = persistedState as Record<string, unknown>;
  const rawFolderStates = candidate['folderStates'];
  const folderStatesWasMalformed = !isRecord(rawFolderStates);
  const folderStates: Record<string, unknown> = isRecord(rawFolderStates) ? rawFolderStates : {};
  const hadMalformedTopLevelContainer =
    folderStatesWasMalformed ||
    !isArray(candidate['folderAccessOrder']) ||
    !isArray(candidate['selectedFilePaths']) ||
    !isArray(candidate['expandedDirectoryPaths']);
  const recoveredState = {
    ...candidate,
    currentFolderId: folderStatesWasMalformed ? null : candidate['currentFolderId'],
    expandedDirectoryPaths: isArray(candidate['expandedDirectoryPaths'])
      ? candidate['expandedDirectoryPaths']
      : [],
    folderAccessOrder: isArray(candidate['folderAccessOrder'])
      ? candidate['folderAccessOrder']
      : [],
    folderStates,
    selectedFilePaths: recoverSelectionKeys(
      isArray(candidate['selectedFilePaths']) ? candidate['selectedFilePaths'] : [],
      'top-level',
      shouldLog,
      onDiscard
    ),
    selectionModel: recoverSelectionModel(candidate['selectionModel'], shouldLog, onDiscard),
  } as unknown as SerializedState;
  if (hadMalformedTopLevelContainer) {
    onDiscard?.();
    if (shouldLog) {
      logger.debug('Migrate - Recovered malformed top-level state containers.');
    }
  }
  const shapeValidFolderStates = Object.fromEntries(
    Object.entries(folderStates).filter(([, folderState]) =>
      looksLikeSerializedFolderState(folderState)
    )
  ) as SerializedState['folderStates'];
  const droppedFolderStateCount =
    Object.keys(folderStates).length - Object.keys(shapeValidFolderStates).length;
  const validFolderStates = Object.fromEntries(
    Object.entries(shapeValidFolderStates).map(([folderId, folderState]) => [
      folderId,
      {
        ...folderState,
        selectedFilePaths: recoverSelectionKeys(
          folderState.selectedFilePaths,
          'folder',
          shouldLog,
          onDiscard
        ),
        selectionModel: recoverSelectionModel(folderState.selectionModel, shouldLog, onDiscard),
      },
    ])
  ) as SerializedState['folderStates'];
  const validFolderIds = new Set(Object.keys(validFolderStates));
  const normalizedCurrentFolderId =
    recoveredState.currentFolderId && validFolderIds.has(recoveredState.currentFolderId)
      ? recoveredState.currentFolderId
      : null;
  const normalizedFolderAccessOrder = recoveredState.folderAccessOrder.filter((folderId) =>
    validFolderIds.has(folderId)
  );
  const normalizedFolderReferenceCount =
    (recoveredState.currentFolderId === normalizedCurrentFolderId ? 0 : 1) +
    (recoveredState.folderAccessOrder.length - normalizedFolderAccessOrder.length);
  if (droppedFolderStateCount > 0 || normalizedFolderReferenceCount > 0) {
    onDiscard?.();
    if (shouldLog) {
      logger.debug('Migrate - Recovered malformed nested folder state.', {
        droppedFolderStateCount,
        normalizedFolderReferenceCount,
      });
    }
  }

  if (shouldLog) {
    logger.debug('Migrate - Returning valid SerializedState summary', {
      folderStateCount: Object.keys(validFolderStates).length,
      hasCurrentFolder: normalizedCurrentFolderId !== null,
      hasSelectionModel: Boolean(recoveredState.selectionModel),
      selectedFileCount: recoveredState.selectedFilePaths.length,
    });
  }
  return {
    ...recoveredState,
    currentFolderId: normalizedCurrentFolderId,
    folderAccessOrder: normalizedFolderAccessOrder,
    folderStates: validFolderStates,
  };
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
