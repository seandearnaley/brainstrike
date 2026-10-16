import { createBrowserChunker } from '@brainstrike/chunking-worker/canonical';
import { describe, expect, it } from 'vitest';
import recorded from '../../indexer/__tests__/fixtures/canonical-provided-chunks.json' with {
  type: 'json',
};
import {
  type CanonicalCatalogPort,
  CanonicalIngestionHost,
  type CanonicalPublicationPort,
  type CanonicalScanTicket,
  type CanonicalSourceFile,
  type CanonicalSourcePort,
} from '../src/browser.js';

const SCOPE = { kind: 'workspace', rootId: 'root' } as const;

/** A source file of the scan, with its content. */
interface Fixture {
  readonly content: string;
  readonly file: CanonicalSourceFile;
}

function sourceFile(fileId: string, relativePath: string, content: string): Fixture {
  return {
    content,
    file: {
      embeddingSetId: 'managed-set',
      fileId,
      fileName: relativePath.split('/').at(-1) ?? relativePath,
      relativePath,
      rootId: SCOPE.rootId,
      sourcePath: relativePath,
      stat: { mtimeMs: 1, size: new TextEncoder().encode(content).byteLength },
    },
  };
}

/** One scan of `fixtures` through the host, over in-memory ports; the text commits it made, by file. */
async function scan(fixtures: readonly Fixture[], maxFileBytes: number) {
  const ticket: CanonicalScanTicket = {
    generation: 1,
    requestId: 'scan',
    scope: SCOPE,
    storeId: 'store',
  };
  const commits = new Map<string, Parameters<CanonicalPublicationPort['commitTextFile']>[0]>();
  const contents = new Map(fixtures.map(({ content, file }) => [file.fileId, content]));
  const source: CanonicalSourcePort = {
    close: async () => {},
    async *discover() {
      yield { files: fixtures.map(({ file }) => file), removed: [] };
      return { errors: [], full: true, truncatedDirectories: [] };
    },
    read: async (file) => {
      const content = contents.get('fileId' in file ? file.fileId : '');
      if (content === undefined) {
        throw new Error('unknown file');
      }
      return { content, stat: (file as CanonicalSourceFile).stat };
    },
  };
  const hashes = new Map<string, string>();
  const catalog: CanonicalCatalogPort = {
    applyManagedCacheBatch: async ({ files }) => {
      for (const file of files) {
        hashes.set(file.fileId, file.contentHash);
      }
    },
    completeFiles: async () => {},
    loadAuthorizedBatch: async ({ files }) =>
      fixtures
        .filter(({ file }) => files.some((entry) => entry.fileId === file.fileId))
        .map(({ file }) => ({ ...file, chunksProcessed: false, contentHash: 'unprocessed' })),
    prepareManagedSourcesBatch: async () => {
      throw new Error('Registered sources need no new identities.');
    },
    removeFiles: async () => {},
    resolveProfile: async () => {
      throw new Error('TEXT resolves no model profile.');
    },
  };
  const publication: CanonicalPublicationPort = {
    abortScan: async () => {},
    beginScan: async () => ticket,
    commitTextFile: async (request) => {
      commits.set(request.file.fileId, request);
    },
    finishScan: async (request) => ({
      reason: request.aborted ? 'aborted' : request.errors.length > 0 ? 'scan-errors' : 'complete',
      scanComplete: !request.aborted && request.errors.length === 0,
      ticket,
    }),
    removeFile: async () => {},
    verifyManifest: async () => ({
      changed: [],
      complete: false,
      missing: [],
      storeId: 'store',
      unexpected: [],
    }),
  };
  const host = new CanonicalIngestionHost({
    catalog,
    chunker: createBrowserChunker(),
    managedCollectionId: 'managed-set',
    publication,
    source,
  });
  const receipt = await host.scan({
    batchSize: 64,
    chunkingOptions: { maxTokens: 256, strategy: 'auto', tokenTrueSizing: true },
    maxFileBytes,
    requestId: 'scan',
    scope: SCOPE,
  });
  await host.close();
  return { commits, receipt };
}

describe('canonical ingestion in a browser worker', () => {
  it('scans, prepares and chunks sources in Chromium, with no Node global', async () => {
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('undefined');
    const python = sourceFile(
      'python',
      'src/greeter.py',
      'class Greeter:\n    def greet(self):\n        return "hello café 🧠"\n'
    );
    const desktop = sourceFile('desktop', recorded.relativePath, recorded.content);
    const { commits, receipt } = await scan([desktop, python], 1_000_000);

    expect(receipt).toMatchObject({ reason: 'complete', scanComplete: true });
    // The recorded desktop canonical file chunks exactly as desktop recorded it.
    expect(commits.get('desktop')?.payload.providedChunks).toEqual(recorded.result.chunks);
    // Python parsed with the vendored grammar, fetched beside its module.
    expect(commits.get('python')?.payload.syntax?.symbols.map((symbol) => symbol.name)).toContain(
      'Greeter'
    );
  });

  it('holds a source to its read bound in UTF-8 bytes, as desktop does', async () => {
    // Two characters, four UTF-16 code units, eight UTF-8 bytes.
    const astral = sourceFile('astral', 'notes/astral.md', '🧠🧠');
    await expect(scan([astral], 7)).rejects.toThrow('exceeds its explicit read bound');
    const { commits, receipt } = await scan([astral], 8);
    expect(receipt).toMatchObject({ reason: 'complete', scanComplete: true });
    expect(commits.get('astral')?.payload.content).toBe('🧠🧠');
  });
});
