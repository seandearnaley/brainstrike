/**
 * Selected-file size prefetch (BST-1208 extraction).
 *
 * The pair used to live inside the 1500-line indexer-integration hook and was
 * only reachable through a full render. These tests pin the two behaviours the
 * Explorer tree grid's Size column depends on: sizes land in the hot cache
 * BEFORE any indexing batch runs, and an unresolvable key is skipped rather
 * than written as a guess.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { renderHook } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { HandleInfo } from '../indexing/background-token-indexer-handles';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import {
  lookupSelectedFileSize,
  useSelectedFileSizePrefetch,
} from '../indexing/use-selected-file-size-prefetch';

const ROOT = '/repo';
const FILE_A = encodeFileSelection(ROOT, '/repo/src/a.ts');

function handleInfo(fileSize: number | undefined): HandleInfo {
  return { fileName: 'a.ts', fileSize };
}

function mutableRef<T>(value: T): MutableRefObject<T> {
  const ref = createRef<T>() as MutableRefObject<T>;
  ref.current = value;
  return ref;
}

describe('lookupSelectedFileSize', () => {
  it('prefers the shared FileTreeIndex over the local handle map', () => {
    const result = lookupSelectedFileSize({
      compositeKey: FILE_A,
      getHandle: () => handleInfo(1024),
      localMap: new Map([[FILE_A, handleInfo(1)]]),
    });
    expect(result).toEqual({
      fileSize: 1024,
      folderId: ROOT,
      normalizedPath: 'src/a.ts',
    });
  });

  it('falls back to the local handle map when the index has no entry', () => {
    const result = lookupSelectedFileSize({
      compositeKey: FILE_A,
      getHandle: () => undefined,
      localMap: new Map([[FILE_A, handleInfo(64)]]),
    });
    expect(result?.fileSize).toBe(64);
  });

  it('returns null when no source knows the size yet', () => {
    expect(
      lookupSelectedFileSize({
        compositeKey: FILE_A,
        getHandle: () => handleInfo(undefined),
        localMap: new Map(),
      })
    ).toBeNull();
  });

  it('returns null for an unsafe path instead of writing a normalized guess', () => {
    expect(
      lookupSelectedFileSize({
        compositeKey: encodeFileSelection(ROOT, '/repo/../secret.txt'),
        getHandle: () => handleInfo(10),
        localMap: new Map(),
      })
    ).toBeNull();
  });
});

describe('useSelectedFileSizePrefetch', () => {
  const renderPrefetch = (args: {
    cache: TokenCacheContextValue | null;
    selectedFiles: ReadonlySet<string>;
  }) =>
    renderHook(() =>
      useSelectedFileSizePrefetch({
        fileHandleMapRef: mutableRef(new Map<string, HandleInfo>([[FILE_A, handleInfo(2048)]])),
        fileHandleMapSize: 1,
        indexGetHandleRef: mutableRef<
          ((folderId: string, path: string) => HandleInfo | undefined) | undefined
        >(undefined),
        indexVersion: 0,
        isTokenCacheOperational: args.cache?.isOperational ?? false,
        selectedFiles: args.selectedFiles,
        tokenCacheRef: mutableRef(args.cache),
      })
    );

  it('writes every resolvable selected size into the hot cache', () => {
    const updateFileSizeCache = vi.fn();
    renderPrefetch({
      cache: { isOperational: true, updateFileSizeCache } as unknown as TokenCacheContextValue,
      selectedFiles: new Set([FILE_A]),
    });
    expect(updateFileSizeCache).toHaveBeenCalledWith(ROOT, 'src/a.ts', 2048);
  });

  it('writes nothing while the token cache is not operational', () => {
    const updateFileSizeCache = vi.fn();
    renderPrefetch({
      cache: { isOperational: false, updateFileSizeCache } as unknown as TokenCacheContextValue,
      selectedFiles: new Set([FILE_A]),
    });
    expect(updateFileSizeCache).not.toHaveBeenCalled();
  });
});
