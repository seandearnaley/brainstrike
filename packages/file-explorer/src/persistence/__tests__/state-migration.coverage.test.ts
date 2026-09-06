import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
}));

vi.mock('@brainstrike/logging', () => ({
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
      devInlineFixtureEnabled: false,
      expandedDirectoryPaths: [],
      folderAccessOrder: [],
      folderStates: {},
      quickFilter: '',
      selectedFilePaths: [],
    });
  }

  it('discards non-object values after logging the migration input', async () => {
    const { migrateState } = await import('../state-migration');

    const result = migrateState('not-an-object', 1, true);

    expectEmptySerializedState(result);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Received persisted state candidate',
      expect.objectContaining({
        valueType: 'string',
        version: 1,
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

    const result = migrateState({ nope: true }, 5, true);

    expectEmptySerializedState(result);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Payload does not match SerializedState shape, discarding.'
    );
  });

  it('logs the migrated serialized state when the payload is valid', async () => {
    const { migrateState } = await import('../state-migration');
    const serializedState = {
      currentFolderId: 'folder-1',
      excludeFilters: [],
      expandedDirectoryPaths: [],
      folderAccessOrder: ['folder-1'],
      folderStates: {
        'folder-1': { selectedFilePaths: ['file.ts'] },
      },
      folderSummaryThreshold: 10,
      includeFilters: [],
      includeProjectTree: false,
      lastActiveTab: 'files',
      maxSelectionCount: 50,
      selectedFilePaths: ['folder-1|@|file.ts'],
      selectionModel: {
        explicitPaths: ['folder-1|@|file.ts'],
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit',
        queryDescriptor: null,
      },
      useRegex: false,
    };

    // Storage version was bumped to 5 (phase-5 root identity re-key).
    const result = migrateState(serializedState, 5, true);

    expect(result.selectionModel).toEqual({
      explicitPaths: ['folder-1|@|file.ts'],
      materializedAt: null,
      materializedPaths: null,
      mode: 'explicit',
      queryDescriptor: null,
    });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Returning valid SerializedState summary',
      expect.objectContaining({
        folderStateCount: 1,
        hasCurrentFolder: true,
        hasSelectionModel: true,
        selectedFileCount: 1,
      })
    );
  });

  it('rejects unsupported future persisted versions', async () => {
    const { migrateState } = await import('../state-migration');
    const serializedState = {
      currentFolderId: 'folder-1',
      excludeFilters: [],
      expandedDirectoryPaths: [],
      folderAccessOrder: [],
      folderStates: {},
      folderSummaryThreshold: 10,
      includeFilters: [],
      includeProjectTree: false,
      lastActiveTab: 'files',
      maxSelectionCount: 50,
      selectedFilePaths: ['folder-1|@|file.ts'],
      useRegex: false,
    };

    // Pass a future version (6) which is higher than the current VERSION (5).
    const result = migrateState(serializedState, 6, true);

    expectEmptySerializedState(result);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Future persisted version 6 is not supported, discarding.'
    );
  });

  it('rejects partially shaped payloads that only expose currentFolderId', async () => {
    const { migrateState } = await import('../state-migration');

    const result = migrateState({ currentFolderId: null }, 5, true);

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
      5,
      true
    );

    expectEmptySerializedState(result);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Payload does not match SerializedState shape, discarding.'
    );
  });
});
