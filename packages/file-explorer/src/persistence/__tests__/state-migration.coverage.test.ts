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

  it('returns non-object values as-is after logging the migration input', async () => {
    const { migrateState } = await import('../state-migration');

    const result = migrateState('not-an-object', 1, true);

    expect(result).toBe('not-an-object');
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Received raw state:',
      'not-an-object',
      'Version:',
      1
    );
  });

  it('logs and returns nullish raw persisted state as-is', async () => {
    const { migrateState } = await import('../state-migration');

    expect(migrateState(null, 1, true)).toBeNull();
    expect(migrateState(undefined, 1, true)).toBeUndefined();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - No state (null or undefined), returning it as is.'
    );
  });

  it('logs and returns null state after unwrap', async () => {
    const { migrateState } = await import('../state-migration');

    const result = migrateState({ state: null, version: 1 }, 1, true);

    expect(result).toBeNull();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - No actual state after unwrap (null/undefined), returning as is.'
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
    };

    const result = migrateState(serializedState, 1, true);

    expect(result.selectionModel).toEqual({
      mode: 'explicit',
      explicitPaths: ['folder-1|@|file.ts'],
      ruleSetJson: null,
      materializedPaths: null,
      materializedAt: null,
      queryDescriptor: null,
    });
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrate - Returning valid SerializedState:',
      result
    );
  });
});
