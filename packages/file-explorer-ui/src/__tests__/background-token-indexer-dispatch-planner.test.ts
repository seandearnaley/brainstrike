// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  planTokenIndexingDispatch,
  type TokenIndexingDispatchCandidate,
} from '../indexing/background-token-indexer-dispatch-planner';

const maxIndexableFileSize = 1024;

function fileCandidate(
  overrides: Partial<Extract<TokenIndexingDispatchCandidate, { kind: 'file' }>> = {}
): Extract<TokenIndexingDispatchCandidate, { kind: 'file' }> {
  return {
    compositeKey: 'root|@|src/app.ts',
    folderId: 'root',
    handle: {
      fileName: 'app.ts',
      fileSize: 128,
      kind: 'web',
      synthetic: false,
    },
    kind: 'file',
    normalizedFilePath: 'src/app.ts',
    selectionPath: 'src/app.ts',
    ...overrides,
  };
}

describe('planTokenIndexingDispatch', () => {
  it('routes selectable files by handle kind and ignores already tracked keys', () => {
    const plan = planTokenIndexingDispatch({
      candidates: [
        fileCandidate({ compositeKey: 'root|@|indexed.ts' }),
        fileCandidate({ compositeKey: 'root|@|in-flight.ts' }),
        fileCandidate({ compositeKey: 'root|@|web.ts' }),
        fileCandidate({
          compositeKey: 'root|@|electron.ts',
          handle: {
            fileName: 'electron.ts',
            fileSize: 256,
            kind: 'electron',
            synthetic: false,
          },
          normalizedFilePath: 'electron.ts',
          selectionPath: 'electron.ts',
        }),
      ],
      indexedKeys: new Set(['root|@|indexed.ts']),
      inFlightKeys: new Set(['root|@|in-flight.ts']),
      maxIndexableFileSize,
    });

    expect(plan.webFiles).toEqual([
      {
        compositeKey: 'root|@|web.ts',
        filePath: 'src/app.ts',
        folderId: 'root',
      },
    ]);
    expect(plan.electronFiles).toEqual([
      {
        compositeKey: 'root|@|electron.ts',
        filePath: 'electron.ts',
        fileSize: 256,
        folderId: 'root',
      },
    ]);
    expect(plan.skipped).toEqual({
      binary: 0,
      invalidPath: 0,
      noHandle: 0,
      tooLarge: 0,
    });
    expect(plan.estimatedElectronBytes).toBe(256);
  });

  it('keeps terminal skip and retry decisions explicit', () => {
    const plan = planTokenIndexingDispatch({
      candidates: [
        fileCandidate({
          compositeKey: 'root|@|image.png',
          handle: {
            fileName: 'image.png',
            fileSize: 64,
            kind: 'web',
            synthetic: false,
          },
          normalizedFilePath: 'image.png',
          selectionPath: 'image.png',
        }),
        fileCandidate({
          compositeKey: 'root|@|large.txt',
          handle: {
            fileName: 'large.txt',
            fileSize: 2048,
            kind: 'web',
            synthetic: false,
          },
          normalizedFilePath: 'large.txt',
          selectionPath: 'large.txt',
        }),
        fileCandidate({
          compositeKey: 'root|@|stale-large.txt',
          handle: {
            fileName: 'stale-large.txt',
            fileSize: 2048,
            kind: 'electron',
            synthetic: true,
          },
          normalizedFilePath: 'stale-large.txt',
          selectionPath: 'stale-large.txt',
        }),
        fileCandidate({
          compositeKey: 'root|@|missing.txt',
          handle: null,
          normalizedFilePath: 'missing.txt',
          selectionPath: 'missing.txt',
        }),
      ],
      indexedKeys: new Set(),
      inFlightKeys: new Set(),
      maxIndexableFileSize,
    });

    expect(plan.indexedKeysToAdd).toEqual(['root|@|image.png', 'root|@|large.txt']);
    expect(plan.pendingNoHandleKeysToAdd).toEqual(['root|@|stale-large.txt', 'root|@|missing.txt']);
    expect(plan.webFiles).toEqual([]);
    expect(plan.electronFiles).toEqual([]);
    expect(plan.skipped).toEqual({
      binary: 1,
      invalidPath: 0,
      noHandle: 1,
      tooLarge: 2,
    });
  });

  it('plans web resolver work without hiding binary or cached-oversize skips', () => {
    const plan = planTokenIndexingDispatch({
      candidates: [
        fileCandidate({
          cachedFileSize: 128,
          compositeKey: 'root|@|nested/late.ts',
          handle: null,
          normalizedFilePath: 'nested/late.ts',
          selectionPath: 'nested/late.ts',
        }),
        fileCandidate({
          compositeKey: 'root|@|nested/photo.jpg',
          handle: null,
          normalizedFilePath: 'nested/photo.jpg',
          resolverFileName: 'photo.jpg',
          selectionPath: 'nested/photo.jpg',
        }),
        fileCandidate({
          cachedFileSize: 2048,
          compositeKey: 'root|@|nested/huge.ts',
          handle: null,
          normalizedFilePath: 'nested/huge.ts',
          selectionPath: 'nested/huge.ts',
        }),
      ],
      hasWebFileHandleResolver: true,
      indexedKeys: new Set(),
      inFlightKeys: new Set(),
      maxIndexableFileSize,
    });

    expect(plan.webResolverFiles).toEqual([
      {
        absolutePath: 'root/nested/late.ts',
        compositeKey: 'root|@|nested/late.ts',
        filePath: 'nested/late.ts',
        folderId: 'root',
      },
    ]);
    expect(plan.indexedKeysToAdd).toEqual(['root|@|nested/photo.jpg']);
    expect(plan.pendingNoHandleKeysToAdd).toEqual(['root|@|nested/huge.ts']);
    expect(plan.pendingNoHandleKeysToDelete).toEqual([
      'root|@|nested/late.ts',
      'root|@|nested/photo.jpg',
    ]);
    expect(plan.skipped).toEqual({
      binary: 1,
      invalidPath: 0,
      noHandle: 0,
      tooLarge: 1,
    });
  });
});
