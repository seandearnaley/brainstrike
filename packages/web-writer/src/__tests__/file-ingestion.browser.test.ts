import { resolveNativeCanonicalProfile } from '@brainstrike/canonical-ingestion/browser';
import { type WebStateStore, webRootPath } from '@brainstrike/web-state-store';
import { afterEach, describe, expect, it } from 'vitest';
import { WebFileIndex } from '../web-writer-client';
import { expectedVector } from './fixtures/synthetic-embedding';
import syntheticEmbeddingWorkerUrl from './fixtures/synthetic-embedding.worker.ts?worker&url';
import { closeTabs, configuredIndex, openTab, savedPreferences, storeConfig } from './writer-tabs';

const folders: string[] = [];

afterEach(async () => {
  await closeTabs();
  const opfs = await navigator.storage.getDirectory();
  for (const name of folders.splice(0)) {
    await opfs.removeEntry(name, { recursive: true }).catch(() => undefined);
  }
});

async function write(
  folder: FileSystemDirectoryHandle,
  path: string,
  content: string | Uint8Array<ArrayBuffer>
): Promise<void> {
  const parts = path.split('/');
  let directory = folder;
  for (const part of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  const file = await directory.getFileHandle(parts.at(-1) ?? path, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}

/** A folder the tab holds a grant for: an OPFS directory, which needs no prompt. */
async function grantedFolder(files: Readonly<Record<string, string | Uint8Array<ArrayBuffer>>>) {
  const name = `folder-${crypto.randomUUID()}`;
  folders.push(name);
  const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, {
    create: true,
  });
  for (const [path, content] of Object.entries(files)) {
    await write(folder, path, content);
  }
  return { folder, rootId: crypto.randomUUID() };
}

async function register(tab: WebStateStore, rootId: string): Promise<void> {
  await tab.workspaceRoots({
    operation: 'register',
    root: { displayName: 'project', path: webRootPath(rootId), preferredId: rootId },
  });
}

async function search(index: WebFileIndex, rootId: string, text: string) {
  return (
    await index.searchScopes({
      limit: 20,
      mode: 'bm25',
      scopes: [{ kind: 'workspace', rootId }],
      text,
    })
  ).hits;
}

async function catalogPaths(tab: WebStateStore, rootId: string): Promise<string[]> {
  return (await tab.sourceCatalog({ operation: 'list' })).files
    .filter((file) => file.rootId === rootId)
    .map((file) => file.path)
    .sort();
}

describe('canonical ingestion in the file index worker', () => {
  it('scans a granted folder into the catalog and the index, and follows its edits and deletions', async () => {
    const { folder, rootId } = await grantedFolder({
      'docs/notes.md': '# Notes\n\nThe zebrafish migration plan, café 🧠.\n',
      'image.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      'src/greeter.py': 'class Greeter:\n    def greet(self):\n        return "hello kestrel"\n',
      'src/one.ts': 'export const answer = "the quokka constant";\n',
    });
    const config = storeConfig();
    const writer = await openTab(config);
    const follower = await openTab(config);
    await register(follower, rootId);
    const index = await configuredIndex(follower);

    // The follower hands the writer its folder; the writer's index worker reads it.
    expect(await index.scan(rootId, folder)).toMatchObject({
      reason: 'complete',
      scanComplete: true,
    });
    // Every text source is in the catalog; the binary file is excluded.
    expect(await catalogPaths(writer, rootId)).toEqual([
      'docs/notes.md',
      'src/greeter.py',
      'src/one.ts',
    ]);
    for (const [text, path] of [
      ['quokka', 'src/one.ts'],
      ['kestrel', 'src/greeter.py'],
      ['zebrafish', 'docs/notes.md'],
    ] as const) {
      expect((await search(index, rootId, text)).map((hit) => hit.relativePath)).toEqual([path]);
    }

    // An edit and a deletion reach the catalog and the index on the next scan.
    await write(folder, 'src/one.ts', 'export const answer = "the pangolin constant";\n');
    await (await folder.getDirectoryHandle('docs')).removeEntry('notes.md');
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });
    expect(await search(index, rootId, 'quokka')).toEqual([]);
    expect((await search(index, rootId, 'pangolin')).map((hit) => hit.relativePath)).toEqual([
      'src/one.ts',
    ]);
    expect(await search(index, rootId, 'zebrafish')).toEqual([]);
    expect(await catalogPaths(writer, rootId)).toEqual(['src/greeter.py', 'src/one.ts']);
    writer.close();
    follower.close();

    // The catalog and the index both survive a reload.
    const reloaded = await openTab(config);
    expect((await search(await configuredIndex(reloaded), rootId, 'kestrel')).length).toBe(1);
    expect(await catalogPaths(reloaded, rootId)).toEqual(['src/greeter.py', 'src/one.ts']);
  });

  it('refuses a root that is not live, and another folder for a root already ingesting one', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const other = await grantedFolder({ 'two.ts': 'export const two = 2;\n' });
    const tab = await openTab(storeConfig());
    const index = await configuredIndex(tab);
    await expect(index.scan(rootId, folder)).rejects.toThrow('Only a live workspace root');

    await register(tab, rootId);
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });
    await expect(index.scan(rootId, other.folder)).rejects.toThrow('another folder');
    expect(await catalogPaths(tab, rootId)).toEqual(['one.ts']);
  });
  it('fails a scan whose pass fails, rather than leaving it waiting', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const index = await configuredIndex(tab);
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });

    // The folder goes away under the root: the next pass cannot list it.
    await (await navigator.storage.getDirectory()).removeEntry(folder.name, { recursive: true });
    await expect(index.scan(rootId, folder)).rejects.toThrow();
    expect(await catalogPaths(tab, rootId)).toEqual(['one.ts']);
  });
  it('answers each of two concurrent scans with its own pass, not the one already running', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const index = await configuredIndex(tab);
    const [first, second] = await Promise.all([
      index.scan(rootId, folder),
      index.scan(rootId, folder),
    ]);
    expect(first).toMatchObject({ scanComplete: true });
    expect(second).toMatchObject({ scanComplete: true });
    expect(second.ticket.requestId).not.toBe(first.ticket.requestId);
  });

  it('refuses a scan of a root deleted since its runtime started', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const index = await configuredIndex(tab);
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });

    await tab.workspaceRoots({ operation: 'delete', paths: [webRootPath(rootId)], rootId });
    await expect(index.scan(rootId, folder)).rejects.toThrow('Only a live workspace root');
    expect(await catalogPaths(tab, rootId)).toEqual([]);
  });
});

/** A collection in the writer's catalog, as Search & Indexing saves one. */
async function collection(
  tab: WebStateStore,
  model: { readonly dimensions: number; readonly modelKey: string } = {
    dimensions: 384,
    modelKey: 'local::Xenova/bge-small-en-v1.5',
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await tab.collections({
    collection: {
      createdAt: '2026-10-16T00:00:00.000Z',
      dimensions: model.dimensions,
      distance: 'cosine',
      id,
      modelId: model.modelKey.split('::')[1] ?? model.modelKey,
      modelKey: model.modelKey,
    },
    operation: 'create',
  });
  return id;
}

/** The production embedding worker over the synthetic runtime, at a model's dimensions. */
function embedder(dimensions: number, delayMs = 0): string {
  const url = new URL(syntheticEmbeddingWorkerUrl, location.href);
  url.hash = `channel=${crypto.randomUUID()}&dimensions=${dimensions}&delay=${delayMs}`;
  return url.href;
}

async function catalogRows(tab: WebStateStore, rootId: string) {
  return (await tab.sourceCatalog({ operation: 'list' })).files
    .filter((file) => file.rootId === rootId)
    .map(({ embeddingSetId, fileId, path }) => ({ embeddingSetId, fileId, path }));
}

/** A scan in flight, and its outcome once it settles: its receipt, or the error it failed with. */
interface RunningScan {
  readonly done: Promise<unknown>;
  readonly settled: () => { readonly outcome: unknown } | undefined;
}

function startScan(
  index: WebFileIndex,
  rootId: string,
  folder: FileSystemDirectoryHandle
): RunningScan {
  let settled: { readonly outcome: unknown } | undefined;
  const done = index
    .scan(rootId, folder)
    .catch((error: unknown) => error)
    .then((outcome) => {
      settled = { outcome };
      return outcome;
    });
  return { done, settled: () => settled };
}

function scanOutcome(outcome: unknown): string {
  return outcome instanceof Error
    ? `it failed: ${outcome.message}`
    : `it completed: ${JSON.stringify(outcome)}`;
}

/**
 * Reads `read` until `ready` holds, while `scan` runs. A scan that settles
 * first fails the wait with its own outcome, so a scan that failed or
 * finished never reads as a timeout. Answers when each value was first read,
 * in ms since the wait began.
 */
async function whileScanning(
  scan: RunningScan,
  read: () => Promise<number>,
  ready: (value: number) => boolean,
  timeoutMs: number
): Promise<string> {
  const started = Date.now();
  const seen: string[] = [];
  let last: number | undefined;
  while (true) {
    const value = await read();
    if (value !== last) {
      seen.push(`${value} at ${Date.now() - started} ms`);
      last = value;
    }
    const settled = scan.settled();
    if (settled) {
      throw new Error(
        `The scan settled before the wait held (${seen.join(', ')}): ${scanOutcome(settled.outcome)}`
      );
    }
    if (ready(value)) {
      return seen.join(', ');
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`The wait did not hold in ${timeoutMs} ms (${seen.join(', ')}).`);
    }
    // On a loaded hosted runner the states awaited arrive seconds apart (BST-2145): a
    // tighter poll gains nothing, and takes CPU from the scan it waits for.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('the file index follows the saved Search & Indexing settings', () => {
  it('refuses until a tab hands it the settings, and settings that fail leave it refusing', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const index = new WebFileIndex(tab);
    const unconfigured = 'no Search & Indexing settings until a tab configures it';
    await expect(search(index, rootId, 'one')).rejects.toThrow(unconfigured);
    await expect(index.scan(rootId, folder)).rejects.toThrow(unconfigured);

    // The same refusals as desktop's native index, for the same stored values.
    await expect(index.configure(null)).rejects.toThrow('Choose a search mode');
    await expect(search(index, rootId, 'one')).rejects.toThrow('Choose a search mode');
    await expect(index.configure(savedPreferences({ enabled: false }))).rejects.toThrow(
      'File indexing is disabled in saved settings.'
    );
    await expect(
      index.configure(savedPreferences({ managedCollectionId: 'absent' }))
    ).rejects.toThrow('missing or ambiguous');
    await expect(index.scan(rootId, folder)).rejects.toThrow('missing or ambiguous');
    await expect(
      index.configure(savedPreferences({ managedCollectionId: null, nativeIndexMode: 'VECTOR' }))
    ).rejects.toThrow('Choose an embedding model and collection');
    const saved = await collection(tab);
    const vector = savedPreferences({ managedCollectionId: saved, nativeIndexMode: 'VECTOR' });
    await expect(index.configure(vector)).rejects.toThrow('needs the embedding worker');
    // A local model with no execution chosen: desktop's own setup refusal.
    await expect(index.configure(vector, embedder(384))).rejects.toThrow(
      'Choose local model execution in Search & Indexing settings.'
    );

    await index.configure(savedPreferences());
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });
  });

  it("holds a root's files in the saved collection, and a change of collection moves them", async () => {
    const { folder, rootId } = await grantedFolder({
      'one.ts': 'export const marker = "pangolin";\n',
    });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const saved = await collection(tab);
    const index = await configuredIndex(tab, savedPreferences({ managedCollectionId: saved }));

    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });
    const [held] = await catalogRows(tab, rootId);
    expect(held).toMatchObject({ embeddingSetId: saved, path: 'one.ts' });
    expect((await search(index, rootId, 'pangolin')).map((hit) => hit.fileId)).toEqual([
      held?.fileId,
    ]);

    // With no collection, the TEXT partition holds the root's files: the collection's are no
    // longer this index's to serve, until a scan ingests the root into the new partition.
    await index.configure(savedPreferences());
    expect(await search(index, rootId, 'pangolin')).toEqual([]);
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });
    const moved = (await catalogRows(tab, rootId)).find((row) => row.embeddingSetId === null);
    expect(moved).toMatchObject({ path: 'one.ts' });
    expect((await search(index, rootId, 'pangolin')).map((hit) => hit.fileId)).toEqual([
      moved?.fileId,
    ]);
  });

  it('lets the newest configuration govern, however the calls interleave', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const index = new WebFileIndex(tab);
    // The second call fails at once; the first is still reading its authority when it does.
    const enabled = index.configure(savedPreferences());
    const disabled = index.configure(savedPreferences({ enabled: false }));
    await enabled;
    await expect(disabled).rejects.toThrow('disabled in saved settings');
    await expect(index.scan(rootId, folder)).rejects.toThrow('disabled in saved settings');
    await expect(search(index, rootId, 'one')).rejects.toThrow('disabled in saved settings');
  });

  it("retires a running scan before it reads a new configuration's authority", async ({
    annotate,
  }) => {
    // Three batches of 64: the later batches' catalog rows are written while the scan runs.
    const { folder, rootId } = await grantedFolder(
      Object.fromEntries(
        Array.from({ length: 150 }, (_, index) => [
          `src/file-${index}.ts`,
          `export const value${index} = "ocelot ${index}";\n`,
        ])
      )
    );
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const index = await configuredIndex(tab);
    const scan = startScan(index, rootId, folder);
    // Into the second batch: its catalog rows are written once the first batch is published and
    // completed, and before any of its own files is chunked.
    const rows = await whileScanning(
      scan,
      async () => (await catalogPaths(tab, rootId)).length,
      (count) => count > 64,
      30_000
    );
    await annotate(`The root's catalog rows, as the scan wrote them: ${rows}`);

    const settledBeforeConfigure = scan.settled();
    await index.configure(savedPreferences({ indexingPolicyPreset: 'full-root' }));
    // The scan was still running when the configure was issued, and the configure retired it.
    expect(settledBeforeConfigure).toBeUndefined();
    expect(scanOutcome(await scan.done)).toContain('File ingestion retired.');
    // Every file the catalog holds as processed is still the store's: none was retired as unowned.
    const processed = (await tab.sourceCatalog({ operation: 'list' })).files.filter(
      (file) => file.rootId === rootId && file.chunksProcessed
    ).length;
    const { counts } = await index.coverageScope({ scope: { kind: 'workspace', rootId } });
    expect(processed).toBeGreaterThan(0);
    expect(counts.indexedFiles).toBeGreaterThanOrEqual(processed);
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });
    expect(await index.coverageScope({ scope: { kind: 'workspace', rootId } })).toMatchObject({
      counts: { indexedFiles: 150 },
    });
  });

  it('keeps a paused index readable, and admits no scan until it resumes', async () => {
    const { folder, rootId } = await grantedFolder({
      'one.ts': 'export const marker = "axolotl";\n',
    });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const index = await configuredIndex(tab);
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });

    await index.configure(savedPreferences({ paused: true }));
    expect(await search(index, rootId, 'axolotl')).toHaveLength(1);
    await expect(index.scan(rootId, folder)).rejects.toThrow('File ingestion is paused.');

    await index.configure(savedPreferences());
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });
  });
});

const MINILM = { dimensions: 384, modelKey: 'local::Xenova/all-MiniLM-L6-v2' } as const;
const MINILM_SELECTION = {
  device: 'wasm',
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
} as const;

describe('vectors in the file index worker', () => {
  it("embeds a root's files with the saved collection's local model, and finds them by vector", async () => {
    const content = 'export const marker = "narwhal";\n';
    const { folder, rootId } = await grantedFolder({
      'notes.md': '# Otters\n\nA wholly different note about otters.\n',
      'one.ts': content,
    });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const saved = await collection(tab, MINILM);
    const index = new WebFileIndex(tab);
    await index.configure(
      savedPreferences({
        managedCollectionId: saved,
        nativeIndexMode: 'VECTOR',
        nativeLocalSelection: MINILM_SELECTION,
      }),
      embedder(MINILM.dimensions)
    );

    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });
    // The collection's profile as desktop resolves it: its model, the saved execution, the catalog's facts.
    const { profile } = resolveNativeCanonicalProfile(
      {
        dimensions: MINILM.dimensions,
        distance: 'cosine',
        id: saved,
        modelId: MINILM_SELECTION.modelId,
        modelKey: MINILM.modelKey,
      },
      MINILM_SELECTION,
      {
        dimensions: MINILM.dimensions,
        id: MINILM_SELECTION.modelId,
        prompts: { document: '', query: '' },
      }
    );
    const coverage = await index.coverageScope({
      profile,
      scope: { embeddingSetId: saved, kind: 'collection' },
    });
    expect(coverage.counts.chunks).toBeGreaterThan(0);
    expect(coverage.counts).toMatchObject({ missingVectors: 0, vectors: coverage.counts.chunks });
    expect(coverage.vectorCoverageComplete).toBe(true);

    // The model states no prompt: a chunk is embedded as it reads, so its own vector finds it at
    // distance 0, ahead of the other file's.
    const { hits } = await index.searchScopes({
      limit: 2,
      mode: 'vector',
      profile,
      scopes: [{ kind: 'workspace', rootId }],
      vector: expectedVector(content.trim(), MINILM.dimensions),
    });
    expect(hits.map(({ relativePath, score }) => ({ relativePath, score }))).toEqual([
      { relativePath: 'one.ts', score: 0 },
      { relativePath: 'notes.md', score: expect.any(Number) },
    ]);
    expect(hits[1]?.score).toBeGreaterThan(0);
  });

  it("embeds a search query with the saved model's query prompt, and searches with it", async () => {
    const { folder, rootId } = await grantedFolder({
      'notes.md': '# Otters\n\nA wholly different note about otters.\n',
      'one.ts': 'export const marker = "narwhal";\n',
    });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    // bge-small's catalog row states a query prompt and no document prompt.
    const saved = await collection(tab);
    const index = new WebFileIndex(tab);
    await expect(index.embedQuery('narwhal')).rejects.toThrow('no Search & Indexing settings');
    await index.configure(savedPreferences());
    await expect(index.embedQuery('narwhal')).rejects.toThrow('needs VECTOR search');

    await index.configure(
      savedPreferences({
        managedCollectionId: saved,
        nativeIndexMode: 'VECTOR',
        nativeLocalSelection: { ...MINILM_SELECTION, modelId: 'Xenova/bge-small-en-v1.5' },
      }),
      embedder(384)
    );
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });
    const { profile, vector } = await index.embedQuery('narwhal');
    expect(profile).toMatchObject({ dimensions: 384, modelId: 'Xenova/bge-small-en-v1.5' });
    expect(vector).toEqual(
      expectedVector('Represent this sentence for searching relevant passages: narwhal', 384)
    );
    const { hits } = await index.searchScopes({
      limit: 10,
      mode: 'vector',
      profile,
      scopes: [{ kind: 'workspace', rootId }],
      vector,
    });
    expect(hits.map((hit) => hit.relativePath).sort()).toEqual(['notes.md', 'one.ts']);
    await expect(index.embedQuery('  ')).rejects.toThrow('needs text');
  });

  it('refuses a query whose saved profile changed while it embedded, rather than answer with the old one', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const minilm = await collection(tab, MINILM);
    const bge = await collection(tab);
    const index = new WebFileIndex(tab);
    const vector = (managedCollectionId: string, modelId: string) =>
      savedPreferences({
        managedCollectionId,
        nativeIndexMode: 'VECTOR',
        nativeLocalSelection: { ...MINILM_SELECTION, modelId },
      });
    // Each batch takes 500 ms, so the query is still embedding when the settings change.
    const slow = embedder(384, 500);
    await index.configure(vector(minilm, MINILM_SELECTION.modelId), slow);
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });

    const query = index.embedQuery('one');
    await index.configure(vector(bge, 'Xenova/bge-small-en-v1.5'), slow);
    await expect(query).rejects.toThrow('saved query profile changed during the query');
    // The next query answers under the settings now saved.
    await expect(index.embedQuery('one')).resolves.toMatchObject({
      profile: { modelId: 'Xenova/bge-small-en-v1.5' },
    });
  });

  it('refuses a hosted collection visibly: the browser has no hosted embedder', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const saved = await collection(tab, {
      dimensions: 1536,
      modelKey: 'openai::text-embedding-3-small',
    });
    const index = new WebFileIndex(tab);
    await index.configure(
      savedPreferences({ managedCollectionId: saved, nativeIndexMode: 'VECTOR' }),
      embedder(1536)
    );
    await expect(index.scan(rootId, folder)).rejects.toThrow('unsupported for provider openai');
    await expect(index.embedQuery('one')).rejects.toThrow('no embedder for provider openai');
  });
});

describe('the corpus cap', () => {
  it('refuses a scan that would take the index past its cap, visibly, and keeps what it holds', async () => {
    const { folder, rootId } = await grantedFolder({
      'a.ts': 'export const a = "lynx";\n',
      'b.ts': 'export const b = "lynx";\n',
      'c.ts': 'export const c = "lynx";\n',
    });
    // One chunk a file, and room for two.
    const tab = await openTab({ ...storeConfig(), testHooks: { fileIndexChunkCap: 2 } });
    await register(tab, rootId);
    const index = await configuredIndex(tab);
    await expect(index.scan(rootId, folder)).rejects.toThrow(
      'The file index holds at most 2 chunks'
    );
    expect(
      (await index.coverageScope({ scope: { kind: 'workspace', rootId } })).counts
    ).toMatchObject({ chunks: 2, indexedFiles: 2 });
    expect(await search(index, rootId, 'lynx')).toHaveLength(2);
    // The next scan refuses the same way: nothing is dropped silently.
    await expect(index.scan(rootId, folder)).rejects.toThrow('at most 2 chunks');
  });
});
