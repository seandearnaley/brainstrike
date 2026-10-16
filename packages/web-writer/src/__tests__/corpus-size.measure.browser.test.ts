/**
 * The browser corpus cap's measurement (BST-1940; owner decision, 16 Oct: measure once and fix the
 * number). Under VECTOR, the larger of the two modes, it fills the file index to its cap with more
 * generated sources than it admits, and reports what the state DB's and the file index's OPFS pools
 * hold. The
 * cap is lowered if the two exceed 1 GB. Skipped unless `VITE_MEASURE_WEB_CORPUS` is set:
 * `VITE_MEASURE_WEB_CORPUS=1 pnpm exec vitest run --project browser src/__tests__/corpus-size.measure.browser.test.ts`
 */
import { webRootPath, webStateExtensionPool, webStateNames } from '@brainstrike/web-state-store';
import { afterEach, describe, expect, it } from 'vitest';
import { WEB_CORPUS_CHUNK_CAP } from '../file-index-extension';
import { WebFileIndex } from '../web-writer-client';
import syntheticEmbeddingWorkerUrl from './fixtures/synthetic-embedding.worker.ts?worker&url';
import { closeTabs, openTab, savedPreferences, storeConfig } from './writer-tabs';

const measuring = Boolean(import.meta.env['VITE_MEASURE_WEB_CORPUS']);
const pilotFiles = Number(import.meta.env['VITE_MEASURE_WEB_CORPUS_FILES'] ?? 0);
const words =
  'index vector browser writer lease epoch chunk thread origin canvas query model folder root search token prompt profile catalog'.split(
    ' '
  );

/** A source of prose: paragraphs of a few sentences, so the chunker splits it into several chunks. */
function source(seed: number): string {
  let state = seed + 1;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return words[state % words.length];
  };
  return Array.from({ length: 40 }, (_, paragraph) =>
    Array.from(
      { length: 4 },
      () => `${Array.from({ length: 14 }, next).join(' ')} ${seed} ${paragraph}.`
    ).join(' ')
  ).join('\n\n');
}

async function poolBytes(name: string): Promise<number> {
  const opfs = await navigator.storage.getDirectory();
  const total = async (directory: FileSystemDirectoryHandle): Promise<number> => {
    let bytes = 0;
    for await (const entry of directory as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      const [, handle] = entry;
      bytes +=
        handle.kind === 'file'
          ? (await (handle as FileSystemFileHandle).getFile()).size
          : await total(handle as FileSystemDirectoryHandle);
    }
    return bytes;
  };
  return total(await opfs.getDirectoryHandle(name));
}

afterEach(closeTabs);

describe.skipIf(!measuring)('the browser corpus at its cap', () => {
  it('reports what the two stores hold', { timeout: 3_600_000 }, async () => {
    const opfs = await navigator.storage.getDirectory();
    const folder = await opfs.getDirectoryHandle(`corpus-${crypto.randomUUID()}`, { create: true });
    const rootId = crypto.randomUUID();
    const config = storeConfig();
    const tab = await openTab(config);
    await tab.workspaceRoots({
      operation: 'register',
      root: { displayName: 'corpus', path: webRootPath(rootId), preferredId: rootId },
    });
    const collectionId = crypto.randomUUID();
    await tab.collections({
      collection: {
        createdAt: '2026-10-16T00:00:00.000Z',
        dimensions: 384,
        distance: 'cosine',
        id: collectionId,
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      },
      operation: 'create',
    });
    const embedder = new URL(syntheticEmbeddingWorkerUrl, location.href);
    embedder.hash = `channel=${crypto.randomUUID()}&dimensions=384`;
    const index = new WebFileIndex(tab);
    await index.configure(
      savedPreferences({
        managedCollectionId: collectionId,
        nativeIndexMode: 'VECTOR',
        nativeLocalSelection: {
          device: 'wasm',
          dimensions: 384,
          dtype: 'q8',
          modelId: 'Xenova/all-MiniLM-L6-v2',
        },
      }),
      embedder.href
    );
    const files = pilotFiles > 0 ? pilotFiles : 2600;
    for (let file = 0; file < files; file++) {
      const handle = await folder.getFileHandle(`doc-${file}.md`, { create: true });
      const writable = await handle.createWritable();
      await writable.write(source(file));
      await writable.close();
    }
    // More sources than the cap admits: the scan fills the index to the cap and refuses there.
    const started = performance.now();
    const outcome = await index.scan(rootId, folder).then(
      () => 'complete',
      (error: unknown) => {
        expect(error).toMatchObject({ code: 'corpus-cap' });
        return 'capped';
      }
    );
    const seconds = Math.round((performance.now() - started) / 1000);
    const { profile } = await index.embedQuery('index');
    const { counts } = await index.coverageScope({
      profile,
      scope: { embeddingSetId: collectionId, kind: 'collection' },
    });
    const state = await poolBytes(webStateNames(config.name).pool);
    const fileIndex = await poolBytes(webStateExtensionPool(config.name, 'files').pool);
    const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);
    console.info(
      `CORPUS outcome=${outcome} files=${files} chunks=${counts.chunks} vectors=${counts.vectors} cap=${WEB_CORPUS_CHUNK_CAP} scan=${seconds}s stateDb=${megabytes(state)}MB fileIndex=${megabytes(fileIndex)}MB total=${megabytes(state + fileIndex)}MB`
    );
    await opfs.removeEntry(folder.name, { recursive: true });
  });
});
