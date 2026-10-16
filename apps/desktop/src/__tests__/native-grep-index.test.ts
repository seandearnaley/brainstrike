// @vitest-environment node
import {
  type IndexerGrepResult,
  type IndexSearchCapability,
  NativeIndexRefusalError,
} from '@brainstrike/indexing-contract/indexer-client';
import { expect, test, vi } from 'vitest';
import { nativeGrepIndex } from '../agent-host-platform/native-grep-index';
import { nativeIndexBoundaryFailure } from '../native-index-boundary-failure';
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

// A plain Error crosses the Main boundary as an untyped fault, which the tool
// guard hides behind "did not complete successfully"; explorers then retried
// grep five to seven times each (2026-10-16 debug pack). The index's typed
// cause crosses as its fixed refusal instead; the status reason, which can
// carry private diagnostics, never does.
test('a grep the index cannot serve refuses with its fixed, model-readable reason', async () => {
  const unavailable = nativeGrepIndex({
    grep: vi.fn<IndexSearchCapability['grep']>(),
    status: async () => ({
      cause: { kind: 'source-failure', message: 'EACCES /Users/someone/private/profile' },
      kind: 'unavailable',
      phase: 'blocked',
      reason: 'EACCES /Users/someone/private/profile',
    }),
  });
  const refused = await unavailable({ pattern: 'needle' }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(NativeIndexRefusalError);
  const log = vi.fn();
  const boundary = nativeIndexBoundaryFailure(refused, log);
  expect(boundary).toMatchObject({
    category: 'availability',
    code: 'native-index-source-failure',
    kind: 'refusal',
    message: 'The search index could not prepare its sources.',
  });
  expect(JSON.stringify(boundary)).not.toContain('/Users/someone');
  // The diagnostic stays in Main's log, under the refusal's correlation id.
  expect(log).toHaveBeenCalledWith(
    'Native index refusal retained its original cause',
    expect.objectContaining({
      cause: expect.objectContaining({ message: 'EACCES /Users/someone/private/profile' }),
      correlationId: boundary.correlationId,
    })
  );
  expect(boundary.correlationId).toEqual(expect.any(String));
  const f = fixture();
  await expect(f.search({ embeddingSetId: 'other', pattern: 'needle' })).rejects.toMatchObject({
    failure: { category: 'input', kind: 'refusal' },
  });
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
