import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceCoverageExpectedFiles,
  classifyMissingCoverageFiles,
  readIndexedRelativePathsByRoot,
  resolveMissingCoverageFiles,
  WORKSPACE_COVERAGE_MAX_CLASSIFICATION_READS,
} from '../workspace-index-coverage-audit';

const ROOT_PATH = '/workspace/root';

function makeFileNode(relativePath: string): IFileNode {
  const absolutePath = `${ROOT_PATH}/${relativePath}`;
  const name = relativePath.split('/').at(-1) ?? relativePath;
  return {
    depth: relativePath.split('/').length,
    handle: {
      kind: 'file',
      name,
      path: absolutePath,
      platform: 'electron',
    } as unknown as IFileNode['handle'],
    name,
    path: absolutePath,
    rootFolderId: ROOT_PATH,
    selectionState: 'unchecked',
    type: 'file',
  };
}

function makeExpectedFile(relativePath: string): {
  node: IFileNode;
  relativePath: string;
} {
  return { node: makeFileNode(relativePath), relativePath };
}

const fileSystemAdapter = {} as FileSystemAdapter;

describe('buildWorkspaceCoverageExpectedFiles', () => {
  it('normalizes node paths to root-relative paths', () => {
    const files = buildWorkspaceCoverageExpectedFiles({
      fileNodes: [makeFileNode('src/index.ts'), makeFileNode('docs/readme.md')],
      rootPath: ROOT_PATH,
    });
    expect(files.map((file) => file.relativePath)).toEqual(['src/index.ts', 'docs/readme.md']);
  });

  it('dedupes nodes that normalize to the same relative path', () => {
    const files = buildWorkspaceCoverageExpectedFiles({
      fileNodes: [makeFileNode('src/index.ts'), makeFileNode('src/index.ts')],
      rootPath: ROOT_PATH,
    });
    expect(files).toHaveLength(1);
  });
});

describe('resolveMissingCoverageFiles', () => {
  it('returns the expected files that have no indexed row', () => {
    const expectedFiles = [
      makeExpectedFile('src/index.ts'),
      makeExpectedFile('src/other.ts'),
      makeExpectedFile('assets/binary-content.md'),
    ];
    const missing = resolveMissingCoverageFiles({
      expectedFiles,
      indexedRelativePaths: new Set(['src/index.ts', 'src/other.ts']),
    });
    expect(missing.map((file) => file.relativePath)).toEqual(['assets/binary-content.md']);
  });

  it('returns stale indexed paths that are no longer expected', () => {
    const expectedFiles = [makeExpectedFile('src/index.ts')];
    const missing = resolveMissingCoverageFiles({
      expectedFiles,
      indexedRelativePaths: new Set(['src/index.ts', 'src/deleted.ts']),
    });
    expect(missing).toEqual([]);
  });
});

describe('classifyMissingCoverageFiles', () => {
  it('classifies null-byte content as content-excluded (never indexable)', async () => {
    const processFiles = vi.fn(async (requests: Array<{ compositeKey: string }>) => ({
      [requests[0]?.compositeKey ?? '']: 'text with a null\0byte',
    }));
    const result = await classifyMissingCoverageFiles({
      fileContentProcessor: { processFiles },
      fileSystemAdapter,
      missingFiles: [makeExpectedFile('assets/binary-content.md')],
      rootPath: ROOT_PATH,
    });
    expect(result.genuinelyMissing).toEqual([]);
    expect(result.contentExcluded).toEqual([
      {
        reason: 'File contains null bytes and cannot be indexed.',
        relativePath: 'assets/binary-content.md',
      },
    ]);
    expect(result.unclassifiedCount).toBe(0);
  });

  it('classifies binary/too-large/inaccessible marker contents as content-excluded', async () => {
    const keys = {
      binary: encodeFileSelection(ROOT_PATH, 'a.md'),
      error: encodeFileSelection(ROOT_PATH, 'd.md'),
      notAccessible: encodeFileSelection(ROOT_PATH, 'c.md'),
      tooLarge: encodeFileSelection(ROOT_PATH, 'b.md'),
    };
    const processFiles = vi.fn(async () => ({
      [keys.binary]: 'Binary file - preview not available',
      [keys.tooLarge]: 'File too large: 2 MB (max: 1 MB)',
      [keys.notAccessible]: 'File not accessible',
      [keys.error]: 'Error accessing file',
    }));
    const result = await classifyMissingCoverageFiles({
      fileContentProcessor: { processFiles },
      fileSystemAdapter,
      missingFiles: [
        makeExpectedFile('a.md'),
        makeExpectedFile('b.md'),
        makeExpectedFile('c.md'),
        makeExpectedFile('d.md'),
      ],
      rootPath: ROOT_PATH,
    });
    expect(result.genuinelyMissing).toEqual([]);
    expect(result.contentExcluded.map((entry) => entry.relativePath)).toEqual([
      'a.md',
      'b.md',
      'c.md',
      'd.md',
    ]);
  });

  it('classifies readable indexable content as genuinely missing', async () => {
    const processFiles = vi.fn(async (requests: Array<{ compositeKey: string }>) => ({
      [requests[0]?.compositeKey ?? '']: 'export const value = 1;',
    }));
    const result = await classifyMissingCoverageFiles({
      fileContentProcessor: { processFiles },
      fileSystemAdapter,
      missingFiles: [makeExpectedFile('src/missed.ts')],
      rootPath: ROOT_PATH,
    });
    expect(result.contentExcluded).toEqual([]);
    expect(result.genuinelyMissing).toEqual(['src/missed.ts']);
  });

  it('treats a file the reader returned no entry for as genuinely missing (fail toward recovery)', async () => {
    const processFiles = vi.fn(async () => ({}));
    const result = await classifyMissingCoverageFiles({
      fileContentProcessor: { processFiles },
      fileSystemAdapter,
      missingFiles: [makeExpectedFile('src/silent.ts')],
      rootPath: ROOT_PATH,
    });
    expect(result.genuinelyMissing).toEqual(['src/silent.ts']);
  });

  it('bounds content reads and reports the unclassified remainder honestly', async () => {
    const processFiles = vi.fn(async (requests: Array<{ compositeKey: string }>) =>
      Object.fromEntries(requests.map((request) => [request.compositeKey, 'text\0']))
    );
    const result = await classifyMissingCoverageFiles({
      fileContentProcessor: { processFiles },
      fileSystemAdapter,
      maxContentReads: 2,
      missingFiles: [
        makeExpectedFile('a.md'),
        makeExpectedFile('b.md'),
        makeExpectedFile('c.md'),
        makeExpectedFile('d.md'),
      ],
      rootPath: ROOT_PATH,
    });
    expect(processFiles).toHaveBeenCalledTimes(1);
    expect(processFiles.mock.calls[0]?.[0]).toHaveLength(2);
    expect(result.contentExcluded).toHaveLength(2);
    expect(result.unclassifiedCount).toBe(2);
  });

  it('reads nothing when there are no missing files', async () => {
    const processFiles = vi.fn(async () => ({}));
    const result = await classifyMissingCoverageFiles({
      fileContentProcessor: { processFiles },
      fileSystemAdapter,
      missingFiles: [],
      rootPath: ROOT_PATH,
    });
    expect(processFiles).not.toHaveBeenCalled();
    expect(result).toEqual({
      contentExcluded: [],
      genuinelyMissing: [],
      unclassifiedCount: 0,
    });
  });

  it('exposes a bounded default read budget', () => {
    expect(WORKSPACE_COVERAGE_MAX_CLASSIFICATION_READS).toBeGreaterThan(0);
    expect(WORKSPACE_COVERAGE_MAX_CLASSIFICATION_READS).toBeLessThanOrEqual(500);
  });
});

describe('readIndexedRelativePathsByRoot', () => {
  it('returns per-root sets of indexed relative paths', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { path: 'src/index.ts', root_id: 'root-a' },
        { path: 'src/other.ts', root_id: 'root-a' },
        { path: 'notes.md', root_id: 'root-b' },
      ],
    }));
    const result = await readIndexedRelativePathsByRoot({
      collectionId: 'collection-1',
      db: { query },
      rootIds: ['root-a', 'root-b'],
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(result.get('root-a')).toEqual(new Set(['src/index.ts', 'src/other.ts']));
    expect(result.get('root-b')).toEqual(new Set(['notes.md']));
  });

  it('returns an empty map without querying when no roots are given', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const result = await readIndexedRelativePathsByRoot({
      collectionId: 'collection-1',
      db: { query },
      rootIds: [],
    });
    expect(query).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('ignores malformed rows instead of throwing', async () => {
    const query = vi.fn(async () => ({
      rows: [{ path: 42, root_id: 'root-a' }, { root_id: 'root-a' }, null, 'nonsense'],
    }));
    const result = await readIndexedRelativePathsByRoot({
      collectionId: 'collection-1',
      db: { query },
      rootIds: ['root-a'],
    });
    expect(result.get('root-a') ?? new Set()).toEqual(new Set());
  });
});
