import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

describe('state-migration coverage', () => {
  beforeEach(() => {
    vi.resetModules();
    mockLogger.debug.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function expectEmptySerializedState(
    result: ReturnType<typeof import('../state-migration').migrateState>
  ) {
    expect(result).toMatchObject({
      currentFolderId: null,
      folderStates: {},
      folderAccessOrder: [],
      selectedFilePaths: [],
      expandedDirectoryPaths: [],
      quickFilter: '',
      devInlineFixtureEnabled: false,
    });
  }

  it('discards non-object values after logging the migration input', async () => {
    const { migrateState } = await import('../state-migration');

    const result = migrateState('not-an-object', 1, true);

    expectEmptySerializedState(result);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Received persisted state candidate',
      expect.objectContaining({
        version: 1,
        valueType: 'string',
      })
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Invalid non-object persisted payload, discarding.'
    );
  });

  it('logs and returns nullish raw persisted state as-is', async () => {
    const { migrateState } = await import('../state-migration');

    expectEmptySerializedState(migrateState(null, 1, true));
    expectEmptySerializedState(migrateState(undefined, 1, true));
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - No state (null or undefined), returning it as is.'
    );
  });

  it('logs and returns null state after unwrap', async () => {
    const { migrateState } = await import('../state-migration');

    const result = migrateState({ state: null, version: 1 }, 1, true);

    expectEmptySerializedState(result);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - No actual state after unwrap (null/undefined), returning as is.'
    );
  });

  it('discards wrapped objects with an undefined state payload', async () => {
    const { migrateState } = await import('../state-migration');

    const result = migrateState({ state: undefined, version: 1 }, 1, true);

    expectEmptySerializedState(result);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Wrapped state missing payload, discarding.'
    );
  });

  it('discards object payloads that do not resemble SerializedState', async () => {
    const { migrateState } = await import('../state-migration');

    const result = migrateState({ nope: true }, 1, true);

    expectEmptySerializedState(result);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Payload does not match SerializedState shape, discarding.'
    );
  });

  it('logs the migrated serialized state when the payload is valid', async () => {
    const { migrateState } = await import('../state-migration');
    const serializedState = {
      currentFolderId: 'folder-1',
      folderStates: {},
      folderAccessOrder: [],
      selectedFilePaths: ['folder-1|@|file.ts'],
      expandedDirectoryPaths: [],
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      includeProjectTree: false,
      folderSummaryThreshold: 10,
      maxSelectionCount: 50,
      lastActiveTab: 'files',
      selectionModel: {
        mode: 'explicit',
        explicitPaths: ['folder-1|@|file.ts'],
        ruleSetJson: null,
        materializedPaths: null,
        materializedAt: null,
        queryDescriptor: null,
      },
    };

    // Storage version was bumped to 4 (phase-4 forest-UI reset).
    const result = migrateState(serializedState, 4, true);

    expect(result.selectionModel).toEqual({
      mode: 'explicit',
      explicitPaths: ['folder-1|@|file.ts'],
      ruleSetJson: null,
      materializedPaths: null,
      materializedAt: null,
      queryDescriptor: null,
    });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Returning valid SerializedState summary',
      expect.objectContaining({
        currentFolderId: 'folder-1',
        folderStateCount: 0,
        hasSelectionModel: true,
        selectedFileCount: 1,
      })
    );
  });

  it('rejects unsupported future persisted versions', async () => {
    const { migrateState } = await import('../state-migration');
    const serializedState = {
      currentFolderId: 'folder-1',
      folderStates: {},
      folderAccessOrder: [],
      selectedFilePaths: ['folder-1|@|file.ts'],
      expandedDirectoryPaths: [],
      includeFilters: [],
      excludeFilters: [],
      useRegex: false,
      includeProjectTree: false,
      folderSummaryThreshold: 10,
      maxSelectionCount: 50,
      lastActiveTab: 'files',
    };

    // Pass a future version (5) which is higher than the current VERSION (4).
    const result = migrateState(serializedState, 5, true);

    expectEmptySerializedState(result);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Future persisted version 5 is not supported, discarding.'
    );
  });

  it('rejects partially shaped payloads that only expose currentFolderId', async () => {
    const { migrateState } = await import('../state-migration');

    const result = migrateState({ currentFolderId: null }, 1, true);

    expectEmptySerializedState(result);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Payload does not match SerializedState shape, discarding.'
    );
  });

  it('rejects payloads that are missing the core serialized collections', async () => {
    const { migrateState } = await import('../state-migration');

    const result = migrateState(
      {
        currentFolderId: 'folder-1',
        folderStates: {},
        selectedFilePaths: [],
        // Missing folderAccessOrder and expandedDirectoryPaths
      },
      1,
      true
    );

    expectEmptySerializedState(result);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Payload does not match SerializedState shape, discarding.'
    );
  });
});
