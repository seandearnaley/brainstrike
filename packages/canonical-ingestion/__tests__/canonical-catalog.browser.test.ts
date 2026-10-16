import type { SourceCatalogPort, SourceCatalogRecord } from '@brainstrike/state-store';
import { sha256Hex } from '@brainstrike/utils/crypto';
import { utf8ByteLength } from '@brainstrike/utils/utf8';
import { describe, expect, it } from 'vitest';
import {
  type CanonicalFileIdentity,
  createNativeCanonicalCatalog,
  type NativeCanonicalCatalogRecord,
} from '../src/browser.js';

const workspace = { kind: 'workspace', rootId: 'root' } as const;
const collection = { embeddingSetId: 'set', kind: 'collection' } as const;
const context = { requestId: 'scan', signal: new AbortController().signal };

function stored(content: string, rootId: string | null): SourceCatalogRecord {
  return {
    chunksCount: null,
    chunksProcessed: false,
    content,
    contentHash: sha256Hex(content),
    createdAt: '2026-10-16T00:00:00.000Z',
    embeddingSetId: 'set',
    fileId: 'file',
    fileName: 'a.ts',
    path: 'src/a.ts',
    rootId,
    stat: { mtimeMs: 1, size: utf8ByteLength(content) },
    updatedAt: '2026-10-16T00:00:00.000Z',
  };
}

/** The catalog over an in-memory source catalog holding `row`; the operations it was asked for. */
function catalogOver(row: SourceCatalogRecord) {
  let current = row;
  const operations: string[] = [];
  const sourceCatalog: SourceCatalogPort['sourceCatalog'] = async (request) => {
    operations.push(request.operation);
    if (request.operation === 'replace') {
      current = { ...current, ...request.files[0]?.source, content: null };
      return { files: [current] };
    }
    return { files: [current] };
  };
  const catalog = createNativeCanonicalCatalog({
    catalog: { sourceCatalog },
    joinNativeRemoval: async () => undefined,
    replaceTrustedBindings: async () => undefined,
    resolveProfile: async () => 'profile',
    resolveScope: async () => ({
      assertCurrent: () => undefined,
      assertDiscoveredSource: () => undefined,
      embeddingSetId: 'set',
      resolveIdentity: (loaded: NativeCanonicalCatalogRecord): CanonicalFileIdentity => ({
        embeddingSetId: loaded.embeddingSetId,
        fileId: loaded.fileId,
        fileName: loaded.fileName,
        relativePath: loaded.rootId === null ? null : loaded.path,
        rootId: loaded.rootId,
        sourcePath: loaded.rootId === null ? null : `fsa:root/${loaded.path}`,
      }),
    }),
  });
  return { catalog, operations };
}

describe('the canonical catalog in a browser worker', () => {
  it('applies a changed workspace source and reads a retained one, with no Node global', async () => {
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('undefined');
    const original = 'export const a = "café 🧠";\n';
    const changed = 'export const a = "changed 🧠";\n';
    const rooted = catalogOver(stored(original, 'root'));
    await rooted.catalog.applyManagedCacheBatch(
      {
        files: [
          {
            content: changed,
            contentHash: sha256Hex(changed),
            embeddingSetId: 'set',
            fileId: 'file',
            fileName: 'a.ts',
            relativePath: 'src/a.ts',
            rootId: 'root',
            sourcePath: 'fsa:root/src/a.ts',
            stat: { mtimeMs: 2, size: utf8ByteLength(changed) },
          },
        ],
        scope: workspace,
      },
      context
    );
    expect(rooted.operations).toContain('replace');

    // A retained collection source is read back within its UTF-8 byte bound, and refused beyond it.
    const retained = catalogOver(stored(original, null));
    const file = {
      embeddingSetId: 'set',
      fileId: 'file',
      fileName: 'a.ts',
      relativePath: null,
      rootId: null,
      sourcePath: null,
    };
    const bytes = utf8ByteLength(original);
    expect(
      (await retained.catalog.readRetainedSource(file, bytes, collection, context)).content
    ).toBe(original);
    await expect(
      retained.catalog.readRetainedSource(file, bytes - 1, collection, context)
    ).rejects.toThrow('byte bound');
  });
});
