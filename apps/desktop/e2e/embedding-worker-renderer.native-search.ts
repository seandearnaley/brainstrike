import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  IndexerCoverageCurrentObservation,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { openConnection } from '@brainstrike/sqlite-native';
import { expect, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import type { VisibleEmbeddingHostBridge } from '../src/types/desktop-electron-api';
import { HomePage } from './page-objects/home-page';

/** Real disk files allow Main's native watcher to exercise the same import corpus. */
export async function createNativeImportRoot(
  fileCount: number,
  sentencesPerFile: number
): Promise<string> {
  const rootPath = await realpath(await mkdtemp(path.join(tmpdir(), 'brainstrike-native-import-')));
  try {
    for (let index = 0; index < fileCount; index += 1) {
      const name = `stress-file-${String(index).padStart(4, '0')}.ts`;
      const sentences = Array.from(
        { length: sentencesPerFile },
        (_, sentenceIndex) =>
          `export const sentence_${sentenceIndex} = "stress-file-${index}-sentence-${sentenceIndex}.";`
      );
      await writeFile(path.join(rootPath, name), sentences.join('\n'));
    }
    return rootPath;
  } catch (error) {
    await rm(rootPath, { force: true, recursive: true });
    throw error;
  }
}

/** Original imported source only: the real canonical parser owns every native chunk. */
export async function createNativeImportedSearchFixture(
  page: Page,
  collectionName: string
): Promise<{ embeddingSetId: string; fileCount: number }> {
  return await page.evaluate(async (name) => {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('Desktop catalog unavailable');
    }
    const embeddingSetId = crypto.randomUUID();
    await api.db.query(
      'INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        embeddingSetId,
        'local::Xenova/bge-small-en-v1.5',
        'Xenova/bge-small-en-v1.5',
        384,
        'cosine',
        name,
      ]
    );
    const files = [
      {
        content:
          'This is a deterministic imported text fixture used to validate desktop chunking and immediate manual backfill.\nThe second chunk ensures manual backfill sees multiple persisted chunks for the same imported file.',
        name: 'mock-file1.txt',
      },
      {
        content:
          'export function fixtureValue(): string { return "desktop import backfill regression"; }\nexport const fixtureLines = ["alpha", "beta", "gamma", "delta"];',
        name: 'mock-file2.ts',
      },
    ];
    for (const file of files) {
      const bytes = new TextEncoder().encode(file.content);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
      await api.db.query(
        'INSERT INTO file_records (id, path, name, size, content, content_hash, embedding_set_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [
          crypto.randomUUID(),
          `/import/${file.name}`,
          file.name,
          bytes.length,
          file.content,
          hash,
          embeddingSetId,
        ]
      );
    }
    return { embeddingSetId, fileCount: files.length };
  }, collectionName);
}

export async function configureNativeCollectionSearch(
  page: Page,
  collectionName: string
): Promise<void> {
  const home = new HomePage(page);
  await home.openSettings();
  await page.getByRole('button', { name: 'Search & Indexing' }).click();
  await page.getByRole('combobox', { name: 'Managed collection' }).click();
  await page.getByRole('option', { exact: true, name: collectionName }).click();
  await page.getByRole('combobox', { name: 'Search mode' }).click();
  await page.getByRole('option', { exact: true, name: 'Text and semantic search' }).click();
  await page.getByRole('combobox', { name: 'Local model execution' }).click();
  await page.getByRole('option', { exact: true, name: 'WASM · Q8' }).click();
  await home.leaveSettings();
}

export async function pauseNativeCollectionSources(page: Page): Promise<void> {
  const home = new HomePage(page);
  await home.openSettings();
  await page.getByRole('button', { name: 'Search & Indexing' }).click();
  await page.getByRole('button', { exact: true, name: 'Pause workspace index' }).click();
  await expect(
    page.getByRole('button', { exact: true, name: 'Resume workspace index' })
  ).toBeVisible();
  await home.leaveSettings();
}

export async function resumeNativeCollectionSources(page: Page): Promise<void> {
  const home = new HomePage(page);
  await home.openSettings();
  await page.getByRole('button', { name: 'Search & Indexing' }).click();
  await page.getByRole('button', { exact: true, name: 'Resume workspace index' }).click();
  await expect(
    page.getByRole('button', { exact: true, name: 'Pause workspace index' })
  ).toBeVisible();
  await home.leaveSettings();
}

export interface NativeCollectionWork {
  readonly hostActive: boolean;
  readonly incomplete: boolean;
  readonly publicationFiles: number;
  readonly vectors: number;
}

export async function observeNativeCollectionWork(
  page: Page,
  collectionId: string
): Promise<NativeCollectionWork | null> {
  return await page.evaluate(async (id) => {
    const browser = window as Window & {
      indexSearch?: IndexSearchCapability;
      embeddingHost?: VisibleEmbeddingHostBridge;
    };
    if (!(browser.indexSearch && browser.embeddingHost)) {
      throw new Error('Native index or embedding host capability unavailable');
    }
    const status = await browser.indexSearch.status();
    if (status.kind !== 'ready') {
      if (status.phase === 'blocked') {
        throw new Error(status.reason);
      }
      return null;
    }
    const observation = await browser.indexSearch.coverageBatch([
      { collectionId: id, rootIds: [] },
    ]);
    if (observation.kind === 'blocked') {
      throw new Error(observation.reason);
    }
    if (observation.kind === 'invalidated') {
      return null;
    }
    const coverage = observation.coverage[0];
    if (!coverage) {
      throw new Error('Native collection coverage omitted its requested scope');
    }
    const host = await browser.embeddingHost.getStatus();
    return {
      hostActive: host.active,
      incomplete: observation.status.rootReadiness.some((root) => !root.scanComplete),
      publicationFiles: (observation.status.publicationProgress ?? [])
        .filter((progress) => progress.scope.kind === 'workspace')
        .reduce((count, progress) => count + progress.acknowledgedFiles, 0),
      vectors: coverage.totals.vectors,
    };
  }, collectionId);
}

export async function waitForNativeCollectionCoverage(
  page: Page,
  collectionId: string,
  fileCount: number
): Promise<IndexerCoverageCurrentObservation> {
  let current: IndexerCoverageCurrentObservation | undefined;
  await expect
    .poll(
      async () =>
        await page
          .evaluate(async (id) => {
            const capability = (window as Window & { indexSearch?: IndexSearchCapability })
              .indexSearch;
            if (!capability) {
              throw new Error('Native index capability unavailable');
            }
            const status = await capability.status();
            if (status.kind !== 'ready') {
              return status;
            }
            return await capability.coverageBatch([{ collectionId: id, rootIds: [] }]);
          }, collectionId)
          .then((observation) => {
            if (observation.kind === 'current') {
              current = observation;
            }
            return observation;
          }),
      { timeout: 120_000 }
    )
    .toMatchObject({
      coverage: [
        { totals: { indexedFiles: fileCount, missingVectors: 0 }, vectorCoverageComplete: true },
      ],
      kind: 'current',
      status: { collectionReadiness: [{ embeddingSetId: collectionId, scanComplete: true }] },
    });
  if (!current) {
    throw new Error('Native collection never published a current observation');
  }
  return current;
}

/** Read-only inspection of this test's disposable native index, never the user profile. */
export async function readNativeCollectionDiagnostics(
  app: ElectronApplication,
  collectionId: string
) {
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const db = openConnection(path.join(userData, 'profiles', 'test', 'index.sqlite'), {
    fileMustExist: true,
    readonly: true,
  });
  try {
    const rows = db
      .prepare(`SELECT c.id, c.content, f.embedding_set_id AS embeddingSetId,
      v.dimensions, v.emb FROM file_chunks c JOIN file_records f ON f.id = c.file_record_id
      LEFT JOIN scoped_vectors v ON v.chunk_pk = c.pk WHERE f.embedding_set_id = ? ORDER BY c.id`)
      .all(collectionId) as {
      content: string;
      dimensions: number | null;
      emb: Uint8Array | null;
      embeddingSetId: string;
      id: string;
    }[];
    const first = rows.find((row) => row.emb !== null);
    if (!(first?.emb && first.dimensions)) {
      throw new Error('Native collection has no vector for its self-similarity proof');
    }
    const bytes = new DataView(first.emb.buffer, first.emb.byteOffset, first.emb.byteLength);
    const vector = Array.from({ length: first.dimensions }, (_, index) =>
      bytes.getFloat32(index * 4, true)
    );
    const indexed = db
      .prepare(`SELECT count(*) AS count FROM file_chunks_fts
      JOIN file_chunks c ON c.pk = file_chunks_fts.rowid JOIN file_records f ON f.id = c.file_record_id
      WHERE f.embedding_set_id = ?`)
      .get(collectionId) as { count: number };
    const ftsEnabled = db
      .prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled")
      .get() as { enabled: number };
    return {
      dimensions: rows.flatMap((row) => (row.dimensions === null ? [] : [row.dimensions])),
      embeddedCount: rows.filter((row) => row.emb !== null).length,
      embeddingSetIds: rows.map((row) => row.embeddingSetId),
      ftsEnabled: ftsEnabled.enabled,
      selfChunkId: first.id,
      totalChunks: rows.length,
      vector,
      withContent: rows.filter((row) => row.content.length > 0).length,
      withFts: indexed.count,
    };
  } finally {
    db.close();
  }
}

export async function searchNativeCollection(
  page: Page,
  collectionId: string,
  vector?: readonly number[]
) {
  return await page.evaluate(
    async ({ id, queryVector }) => {
      const capability = (window as Window & { indexSearch?: IndexSearchCapability }).indexSearch;
      if (!capability) {
        throw new Error('Native index capability unavailable');
      }
      const status = await capability.status();
      if (status.kind !== 'ready' || status.embedding.indexMode !== 'vector-configured') {
        throw new Error('Native collection has no configured vector profile');
      }
      return await capability.search({
        collectionId: id,
        limit: 5,
        rootIds: [],
        ...(queryVector
          ? { mode: 'vector' as const, profile: status.embedding.profile, vector: queryVector }
          : { mode: 'bm25' as const, text: 'backfill' }),
      });
    },
    { id: collectionId, queryVector: vector }
  );
}
