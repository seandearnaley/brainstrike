// @vitest-environment node
import type {
  IndexerGrepResult,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { expect, test, vi } from 'vitest';
import { nativeGrepIndex } from '../agent-host-platform/native-grep-index';
import { hit, storeId } from './native-scoped-search-fixture';

function fixture() {
  const recorded: IndexerGrepResult = {
    candidateCount: 1,
    candidatesTruncated: false,
    embedding: { indexMode: 'text-only' },
    hits: [
      {
        ...hit,
        content: 'first\nneedle[.] literal\nlast',
        endLine: 3,
        relativePath: 'selected.md',
        rootId: 'root',
      },
    ],
    scanLimited: false,
    storeId,
    truncated: false,
  };
  const grep = vi.fn<IndexSearchCapability['grep']>(async () => recorded);
  const status: IndexSearchCapability['status'] = async () => ({
    authorizedCollectionIds: ['selected'],
    authorizedRootIds: ['root'],
    embedding: { indexMode: 'text-only' },
    kind: 'ready',
    rootReadiness: [{ rootId: 'root', scanComplete: true }],
    storeId,
  });
  return { grep, recorded, search: nativeGrepIndex({ grep, status }) };
}
test('native grep retains literal matching, selected file scope, line metadata and context', async () => {
  const f = fixture();
  const result = await f.search({
    contextLines: 1,
    filePaths: ['selected.md'],
    pattern: 'needle[.]',
    rootId: 'root',
  });
  expect(result.matches).toMatchObject([
    {
      after: ['last'],
      before: ['first'],
      line: 2,
      lineText: 'needle[.] literal',
      path: 'selected.md',
      rootId: 'root',
    },
  ]);
  expect(f.grep).toHaveBeenCalledWith({
    caseSensitive: false,
    filePaths: ['selected.md'],
    isRegex: false,
    limit: 200,
    pattern: 'needle[.]',
    rootIds: ['root'],
  });
});
test('native grep preserves partial scan and candidate truncation notices', async () => {
  const f = fixture();
  f.grep.mockResolvedValue({ ...f.recorded, candidatesTruncated: true, scanLimited: true });
  expect(await f.search({ pattern: 'needle' })).toMatchObject({
    candidatesTruncated: true,
    scanLimited: true,
  });
});
test('native grep refuses foreign provenance rather than returning it', async () => {
  const f = fixture();
  f.grep.mockResolvedValue({
    ...f.recorded,
    hits: [{ ...f.recorded.hits[0]!, rootId: 'foreign' }],
  });
  await expect(f.search({ pattern: 'needle', rootId: 'root' })).rejects.toThrow(
    'outside its requested scope'
  );
});

test('unconfigured indexing contributes no candidates to the existing fresh-file grep', async () => {
  const grep = vi.fn<IndexSearchCapability['grep']>();
  const search = nativeGrepIndex({
    grep,
    status: async () => ({
      kind: 'unavailable',
      phase: 'setup-required',
      reason: 'Choose a search mode in Search & Indexing settings.',
    }),
  });
  expect(await search({ pattern: 'needle', rootId: 'root' })).toMatchObject({
    candidatesTruncated: false,
    matches: [],
    scanLimited: false,
    totalMatches: 0,
    truncated: false,
  });
  expect(grep).not.toHaveBeenCalled();
  await expect(search({ embeddingSetId: 'selected', pattern: 'needle' })).rejects.toThrow(
    'Choose a search mode'
  );
});

test.each(['preparing', 'blocked'] as const)(
  'native grep retains the %s index failure rather than hiding it behind live search',
  async (phase) => {
    const grep = vi.fn<IndexSearchCapability['grep']>();
    const search = nativeGrepIndex({
      grep,
      status: async () => ({ kind: 'unavailable', phase, reason: 'Index is unavailable' }),
    });
    await expect(search({ pattern: 'needle' })).rejects.toThrow('Index is unavailable');
    expect(grep).not.toHaveBeenCalled();
  }
);
