import { describe, expect, it } from 'vitest';
import { FILE_EXPLORER_STORAGE_VERSION } from '../persistence/persistence-constants';

describe('store version/type guard', () => {
  it('FILE_EXPLORER_STORAGE_VERSION is pinned at 5 (storage v5 root identity re-key)', () => {
    // This assertion intentionally pins the version to catch accidental bumps.
    // The v4→v5 bump is intentional: currentFolderId/folderStates keys/composite
    // folderId all become RootId UUIDs (not paths) as of phase 5 root identity.
    expect(FILE_EXPLORER_STORAGE_VERSION).toBe(5);
  });
});
