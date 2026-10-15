// @vitest-environment node
import type { ScopedFileChunkBounds, ScopedIndexerPort } from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
import { NativeAuthorityTransitionError } from '../native-authority-transition';
import { fixture, storeId } from './native-scoped-search-fixture';

const rootId = 'root-1';
const workspaceBinding = (fileId: string, relativePath: string) => ({
  embeddingSetId: null,
  fileId,
  profile: null,
  relativePath,
  rootId,
  sourcePath: `/work/${relativePath}`,
});
const chunk = (index: number, startLine: number, endLine: number) => ({
  chunkId: String(index).repeat(64).slice(0, 64),
  contentHash: 'f'.repeat(64),
  endLine,
  startLine,
  tokenCount: (endLine - startLine + 1) * 10,
});

function workspaceFixture() {
  const f = fixture();
  f.replaceAuthority({
    ...f.getAuthority(),
    bindings: [
      workspaceBinding('file-a', 'src/a.ts'),
      workspaceBinding('file-b', 'docs/b.md'),
      { ...workspaceBinding('file-other', 'src/a.ts'), rootId: 'root-2' },
    ],
    rootIds: [rootId, 'root-2'],
  });
  const read = vi.fn<ScopedIndexerPort['readScopedFileChunkBounds']>(
    async (): Promise<ScopedFileChunkBounds> => ({
      authorityEpoch: 'd'.repeat(64),
      authorityRevision: 1,
      files: [
        {
          chunks: [chunk(1, 1, 40), chunk(2, 41, 80)],
          contentHash: 'a'.repeat(64),
          fileId: 'file-a',
          kind: 'indexed',
          snapshotHash: 'b'.repeat(64),
        },
        { fileId: 'file-b', kind: 'not-indexed' },
      ],
      storeId,
    })
  );
  f.port.readScopedFileChunkBounds = read;
  return { ...f, read };
}

it("maps each path to its root's binding and answers in request order", async () => {
  const f = workspaceFixture();
  const result = await f.capability.fileChunks({
    paths: ['docs/b.md', '/src/a.ts', 'src/ignored.ts'],
    rootId,
  });

  expect(f.read).toHaveBeenCalledExactlyOnceWith({
    fileIds: ['file-b', 'file-a'],
    scope: { kind: 'workspace', rootId },
  });
  expect(result).toEqual({
    files: [
      { kind: 'not-indexed', path: 'docs/b.md' },
      {
        chunks: [chunk(1, 1, 40), chunk(2, 41, 80)],
        contentHash: 'a'.repeat(64),
        kind: 'indexed',
        path: '/src/a.ts',
      },
      // A path the index does not bind is never an empty chunk list.
      { kind: 'outside-index', path: 'src/ignored.ts' },
    ],
    rootId,
    storeId,
  });
});

it('reads nothing when no requested path is bound in the root', async () => {
  const f = workspaceFixture();
  const result = await f.capability.fileChunks({ paths: ['src/a.ts'], rootId: 'root-3' });

  expect(f.read).not.toHaveBeenCalled();
  expect(result.files).toEqual([{ kind: 'outside-index', path: 'src/a.ts' }]);
});

it('refuses a reply from a different store', async () => {
  const f = workspaceFixture();
  const reply = await f.read.getMockImplementation()!({});
  f.read.mockResolvedValueOnce({ ...reply, storeId: 'e'.repeat(64) });

  await expect(f.capability.fileChunks({ paths: ['src/a.ts'], rootId })).rejects.toThrow(
    'different store'
  );
});

it('refuses bounds whose source changed during the read', async () => {
  const f = workspaceFixture();
  const reply = await f.read.getMockImplementation()!({});
  f.read.mockImplementationOnce(async () => {
    f.replaceAuthority({ ...f.getAuthority(), generation: 2 });
    return reply;
  });

  await expect(f.capability.fileChunks({ paths: ['src/a.ts'], rootId })).rejects.toBeInstanceOf(
    NativeAuthorityTransitionError
  );
});

it.each([0, 101])('refuses %i paths', async (count) => {
  const f = workspaceFixture();
  await expect(
    f.capability.fileChunks({
      paths: Array.from({ length: count }, (_, index) => `f${index}.ts`),
      rootId,
    })
  ).rejects.toThrow('1 to 100 paths');
});
