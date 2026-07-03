import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbQueryResult,
  BrainstrikeDbTransactionClient,
  BrainstrikeDbWorkOptions,
} from '../src/architecture/brainstrike-db-client-contract.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import type { FileRecord } from '../src/models/file-record.js';
import { TursoEmbeddingSetsRepository } from '../src/repositories/turso-embedding-sets-repository.js';
import { TursoFileChunkRepository } from '../src/repositories/turso-file-chunk-repository.js';
import { TursoFileRecordRepository } from '../src/repositories/turso-file-record-repository.js';
import { HybridSearchService } from '../src/search/hybrid-search-service.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../../..');
const qualityReportPath = join(
  repoRoot,
  'docs/turso-migration/2026-07-03-turso-lexical-search-quality-profile.md'
);
const migrationLedgerPath = join(repoRoot, 'docs/turso-migration/migration-ledger.md');
const searchArchitecturePath = join(repoRoot, 'docs/turso-migration/search-index-architecture.md');
const appShellReadmePath = join(repoRoot, 'packages/app-shell/README.md');
const assistantMemoryRepositoryPath = join(
  repoRoot,
  'packages/app-shell/src/assistant-memory-repository.ts'
);
const assistantOmSegmentPath = join(repoRoot, 'packages/app-shell/src/assistant-om-segment.ts');
const desktopGrepSearchToolPath = join(
  repoRoot,
  'apps/desktop/src/assistant-server/grep-search-tool.ts'
);
const desktopRendererMainPath = join(repoRoot, 'apps/desktop/src/renderer/main.tsx');
const embeddingHostAppPath = join(
  repoRoot,
  'apps/desktop/src/renderer/components/embedding-host-app.tsx'
);
const atomicTransactionPath = join(repoRoot, 'packages/db/src/atomic-transaction.ts');
const dbHostEntryPath = join(repoRoot, 'apps/desktop/src/db-host-entry.ts');
const dbIpcPath = join(repoRoot, 'apps/desktop/src/ipc-domains/db-ipc.ts');
const dbMainPath = join(repoRoot, 'apps/desktop/src/db-main.ts');
const desktopPreloadPath = join(repoRoot, 'apps/desktop/src/preload.ts');
const electronApiTypesPath = join(repoRoot, 'packages/types/src/electron-api.ts');
const quickOpenQueryPath = join(repoRoot, 'packages/db/src/search/quick-open-query.ts');
const persistentTokenCachePath = join(
  repoRoot,
  'packages/file-explorer-ui/src/indexing/use-persistent-token-cache.ts'
);
const tokenCacheContextPath = join(
  repoRoot,
  'packages/file-explorer-ui/src/indexing/token-cache-context.tsx'
);
const tokenCacheIndexPath = join(repoRoot, 'packages/token-cache/src/index.ts');
const useTokenCachePath = join(repoRoot, 'packages/token-cache/src/use-token-cache.ts');
const hybridSearchServicePath = join(repoRoot, 'packages/db/src/search/hybrid-search-service.ts');

describe('Turso primary-store lexical search quality profile', () => {
  let client: TursoOwnerClient;
  let embeddingSetId: string;
  let fileRecordsRepository: TursoFileRecordRepository;
  let repository: TursoFileChunkRepository;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-search-quality-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    const embeddingSetsRepository = new TursoEmbeddingSetsRepository(client);
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:search-quality',
      'search quality',
      3,
      'cosine'
    );
    embeddingSetId = embeddingSet.id;
    fileRecordsRepository = new TursoFileRecordRepository(client);
    repository = new TursoFileChunkRepository(client);
    await seedSearchQualityCorpus({
      embeddingSetId,
      fileRecordsRepository,
      repository,
    });
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('profiles exact primary-store gram lexical quality on a tiny code corpus', async () => {
    const results = await repository.fullTextSearch('authentication login', {
      embeddingSetId,
      limit: 5,
      threshold: 0,
    });
    const resultIds = results.map((result) => result.chunk.id);
    const judgedRelevantIds = ['chunk-auth-focused', 'chunk-auth-context'];

    expect(resultIds).toEqual(judgedRelevantIds);
    expect(precisionAt(resultIds, judgedRelevantIds, 5)).toBe(0.4);
    expect(recallAt(resultIds, judgedRelevantIds, 5)).toBe(1);
    expect(resultIds).not.toContain('chunk-auth-only');
    expect(resultIds).not.toContain('chunk-login-only');
    expect(resultIds).not.toContain('chunk-near-stem');

    await expect(
      repository.fullTextSearch('"rate limit" -test', {
        embeddingSetId,
        limit: 5,
        threshold: 0,
      })
    ).resolves.toEqual([
      expect.objectContaining({
        chunk: expect.objectContaining({ id: 'chunk-rate-prod' }),
      }),
    ]);
  });

  it('keeps real hybrid search on the repository lexical source', async () => {
    const hybrid = new HybridSearchService(repository);

    const response = await hybrid.search('authentication login', [1, 0, 0], {
      embeddingSetId,
      ftsLimit: 8,
      ftsThreshold: 0,
      limit: 3,
      minSourceCount: 2,
      vectorLimit: 8,
      vectorThreshold: 0,
    });

    expect(response.results.map((result) => result.chunk.id)).toEqual([
      'chunk-auth-focused',
      'chunk-auth-context',
    ]);
    expect(response.results.every((result) => result.sourceCount === 2)).toBe(true);
    expect(response.metadata.ftsResultCount).toBe(2);
    expect(response.metadata.vectorResultCount).toBeGreaterThan(2);
  });

  it('uses gram sidecars as the lexical candidate source', async () => {
    const capturedQueries: CapturedQuery[] = [];
    const capturingRepository = new TursoFileChunkRepository(
      createCapturingClient(client, capturedQueries)
    );

    await capturingRepository.fullTextSearch('authentication login', {
      embeddingSetId,
      limit: 5,
      threshold: 0,
    });

    const lexicalQuery = capturedQueries.find((query) => query.sql.includes('candidate_chunks AS'));
    expect(lexicalQuery).toBeDefined();
    expect(lexicalQuery?.sql).toContain('FROM file_chunk_content_grams gc');
    expect(lexicalQuery?.sql).toContain('JOIN file_chunk_content_index fci');
    expect(lexicalQuery?.sql).not.toContain('lower(fc.content)');

    const plan = await client.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${lexicalQuery?.sql}`,
      lexicalQuery?.params
    );
    const planText = plan.rows.map((row) => row.detail).join('\n');

    expect(planText).toContain('file_chunk_content_grams');
    expect(planText).not.toMatch(/SCAN (?:fc|file_chunks)\b/);
  });

  it('records the lexical-search decision boundary in migration docs', async () => {
    const [
      qualityReport,
      migrationLedger,
      searchArchitecture,
      appShellReadme,
      assistantMemoryRepository,
      assistantOmSegment,
      desktopGrepSearchTool,
      desktopRendererMain,
      embeddingHostApp,
      atomicTransaction,
      dbHostEntry,
      dbIpc,
      dbMain,
      desktopPreload,
      electronApiTypes,
      quickOpenQuery,
      persistentTokenCache,
      tokenCacheContext,
      tokenCacheIndex,
      useTokenCache,
      hybridSearchService,
    ] = await Promise.all([
      readFile(qualityReportPath, 'utf8'),
      readFile(migrationLedgerPath, 'utf8'),
      readFile(searchArchitecturePath, 'utf8'),
      readFile(appShellReadmePath, 'utf8'),
      readFile(assistantMemoryRepositoryPath, 'utf8'),
      readFile(assistantOmSegmentPath, 'utf8'),
      readFile(desktopGrepSearchToolPath, 'utf8'),
      readFile(desktopRendererMainPath, 'utf8'),
      readFile(embeddingHostAppPath, 'utf8'),
      readFile(atomicTransactionPath, 'utf8'),
      readFile(dbHostEntryPath, 'utf8'),
      readFile(dbIpcPath, 'utf8'),
      readFile(dbMainPath, 'utf8'),
      readFile(desktopPreloadPath, 'utf8'),
      readFile(electronApiTypesPath, 'utf8'),
      readFile(quickOpenQueryPath, 'utf8'),
      readFile(persistentTokenCachePath, 'utf8'),
      readFile(tokenCacheContextPath, 'utf8'),
      readFile(tokenCacheIndexPath, 'utf8'),
      readFile(useTokenCachePath, 'utf8'),
      readFile(hybridSearchServicePath, 'utf8'),
    ]);

    expect(qualityReport).toContain('precision@5 = 0.400');
    expect(qualityReport).toContain('recall@5 = 1.000');
    expect(qualityReport).toContain('chunk-near-stem');
    expect(migrationLedger).toContain('#1456 `Profile Turso lexical search quality`');
    expect(migrationLedger).toContain('#1458 `Default desktop runtime to Turso`');
    expect(migrationLedger).toContain('#1459 `docs(turso): neutralize stale runtime wording`');
    expect(migrationLedger).toContain('#1460 `fix(turso): harden runtime SQL seams`');
    expect(migrationLedger).toContain('Turso Lexical Search Decision Boundary');
    expect(migrationLedger).toContain('quick-open filename lookup uses `file_record_name_grams`');
    expect(migrationLedger).not.toContain('In-flight slice on this branch');
    expect(migrationLedger).not.toContain('through #1455 at `cb9ab61ce`');
    expect(migrationLedger).not.toContain('through #1457 at `036962da6`');
    expect(migrationLedger).not.toContain('feature head `23d2ac3d`');
    expect(migrationLedger).not.toContain('post-#1456 branch');
    expect(migrationLedger).not.toContain('post-#1458 branch');
    expect(migrationLedger).not.toContain('post-#1459 branch');
    expect(migrationLedger).toContain('post-#1460 branch');
    expect(migrationLedger).toContain(
      'explicit PGlite reset recreates `<profile>/pgdata`; Turso and unset-runtime reset recreate only `<profile>`'
    );
    expect(migrationLedger).not.toContain(
      'grep, quick-open, DB Explorer search, and hybrid lexical search use'
    );
    expect(searchArchitecture).toContain('Split native FTS/search-index ownership is triggered');
    expect(searchArchitecture).toContain(
      'Quick-open filename search is a separate name-gram sidecar path'
    );
    expect(appShellReadme).toContain('runtime-backed thread and run-record persistence');
    expect(appShellReadme).not.toContain('PGlite-backed thread and run-record persistence');
    expect(dbHostEntry).toContain('The DB host dispatches one request at a time');
    expect(dbHostEntry).not.toContain('PGlite runs through a single connection in this host');
    expect(dbMain).not.toContain('profile-scoped pgdata and lock files');
    expect(atomicTransaction).not.toContain('PGlite lives in the main process');
    expect(atomicTransaction).not.toContain('pglite.transaction() in the main process');
    expect(dbIpc).not.toContain('pglite.transaction() in main');
    expect(desktopPreload).not.toContain('inside one pglite.transaction()');
    expect(electronApiTypes).not.toContain('inside ONE\n   * `pglite.transaction()`');
    expect(desktopGrepSearchTool).not.toContain('indexed PGlite file chunks');
    expect(desktopGrepSearchTool).not.toContain('INDEXED (PGlite trigram) search');
    expect(desktopRendererMain).not.toContain('main-process\n  // filesystem PGlite');
    expect(embeddingHostApp).not.toContain('main-process filesystem PGlite');
    expect(quickOpenQuery).toContain('runtime-specific file-record repositories');
    expect(persistentTokenCache).not.toContain('stored in PGlite');
    expect(tokenCacheContext).not.toContain('PGlite database type');
    expect(tokenCacheIndex).not.toContain('PGlite-backed persistent storage');
    expect(useTokenCache).not.toContain('cold cache (PGlite)');
    expect(assistantMemoryRepository).not.toContain('PGlite returns ::bigint as a string');
    expect(assistantOmSegment).not.toContain('pglite-mastra-memory/memory-factory.ts');
    expect(searchArchitecture).not.toContain('Turso must provide an indexed candidate source');
    expect(hybridSearchService).toContain('Drizzle, Electron, PGlite, Turso');
  });
});

interface SeedSearchQualityCorpusInput {
  readonly embeddingSetId: string;
  readonly fileRecordsRepository: TursoFileRecordRepository;
  readonly repository: TursoFileChunkRepository;
}

interface CapturedQuery {
  readonly params?: readonly unknown[];
  readonly sql: string;
}

async function seedSearchQualityCorpus({
  embeddingSetId,
  fileRecordsRepository,
  repository,
}: SeedSearchQualityCorpusInput): Promise<void> {
  const records = [
    createRecord({
      embeddingSetId,
      id: 'file-auth-focused',
      name: 'login-handler.ts',
      path: 'src/auth/login-handler.ts',
    }),
    createRecord({
      embeddingSetId,
      id: 'file-auth-context',
      name: 'session-policy.ts',
      path: 'src/auth/session-policy.ts',
    }),
    createRecord({
      embeddingSetId,
      id: 'file-auth-only',
      name: 'auth-only.ts',
      path: 'src/auth/auth-only.ts',
    }),
    createRecord({
      embeddingSetId,
      id: 'file-login-only',
      name: 'login-only.ts',
      path: 'src/auth/login-only.ts',
    }),
    createRecord({
      embeddingSetId,
      id: 'file-near-stem',
      name: 'near-stem.ts',
      path: 'src/auth/near-stem.ts',
    }),
    createRecord({
      embeddingSetId,
      id: 'file-rate-prod',
      name: 'rate-prod.ts',
      path: 'src/rate-prod.ts',
    }),
    createRecord({
      embeddingSetId,
      id: 'file-rate-test',
      name: 'rate-test.ts',
      path: 'test/rate-test.ts',
    }),
  ];
  for (const record of records) {
    await fileRecordsRepository.createWithContent(record);
  }

  await repository.insertMany([
    createChunk({
      content: 'login authentication token validator',
      embedding: [1, 0, 0],
      embeddingSetId,
      fileRecordId: 'file-auth-focused',
      id: 'chunk-auth-focused',
    }),
    createChunk({
      content:
        'session policy checks authentication context before login token renewal for desktop users',
      embedding: [0.95, 0.05, 0],
      embeddingSetId,
      fileRecordId: 'file-auth-context',
      id: 'chunk-auth-context',
    }),
    createChunk({
      content: 'authentication credential verifier without the sign-in action term',
      embedding: [0.7, 0.2, 0],
      embeddingSetId,
      fileRecordId: 'file-auth-only',
      id: 'chunk-auth-only',
    }),
    createChunk({
      content: 'login route handler without the credential verification term',
      embedding: [0.65, 0.1, 0],
      embeddingSetId,
      fileRecordId: 'file-login-only',
      id: 'chunk-login-only',
    }),
    createChunk({
      content: 'authenticate users when they log in with passkeys',
      embedding: [0.9, 0.3, 0],
      embeddingSetId,
      fileRecordId: 'file-near-stem',
      id: 'chunk-near-stem',
    }),
    createChunk({
      content: 'production rate limit for login attempts',
      embedding: [0.1, 1, 0],
      embeddingSetId,
      fileRecordId: 'file-rate-prod',
      id: 'chunk-rate-prod',
    }),
    createChunk({
      content: 'test rate limit login helper',
      embedding: [0.1, 0.9, 0],
      embeddingSetId,
      fileRecordId: 'file-rate-test',
      id: 'chunk-rate-test',
    }),
  ]);
}

function createCapturingClient(
  baseClient: TursoOwnerClient,
  capturedQueries: CapturedQuery[]
): BrainstrikeDbExecutionClient {
  return {
    exec: baseClient.exec,
    query: async <TRecord = unknown>(
      sql: string,
      params?: readonly unknown[],
      options?: BrainstrikeDbWorkOptions
    ): Promise<BrainstrikeDbQueryResult<TRecord>> => {
      capturedQueries.push({ params, sql });
      return baseClient.query<TRecord>(sql, params, options);
    },
    transaction: async <TResult>(
      callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>,
      options?: BrainstrikeDbWorkOptions
    ): Promise<TResult> => baseClient.transaction(callback, options),
  };
}

function precisionAt(
  resultIds: readonly string[],
  relevantIds: readonly string[],
  k: number
): number {
  const relevant = new Set(relevantIds);
  const topK = resultIds.slice(0, k);
  return topK.filter((id) => relevant.has(id)).length / Math.max(k, 1);
}

function recallAt(resultIds: readonly string[], relevantIds: readonly string[], k: number): number {
  const relevant = new Set(relevantIds);
  const topK = new Set(resultIds.slice(0, k));
  return relevantIds.filter((id) => topK.has(id)).length / Math.max(relevant.size, 1);
}

function createRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    content: 'const answer = 42;',
    contentHash: `hash-${overrides.id ?? 'file'}`,
    createdAt: '2026-07-03T08:00:00.000Z',
    id: 'file-default',
    name: 'index.ts',
    path: 'src/index.ts',
    size: 42,
    tokenCount: 8,
    updatedAt: '2026-07-03T08:00:00.000Z',
    ...overrides,
  };
}

function createChunk(overrides: Partial<FileChunkInsert> = {}): FileChunkInsert {
  return {
    chunkIndex: 0,
    chunkSize: overrides.content?.length ?? 18,
    chunkType: 'code',
    content: 'const answer = 42;',
    contentHash: `hash-${overrides.id ?? 'chunk'}`,
    createdAt: '2026-07-03T08:10:00.000Z',
    fileRecordId: 'file-default',
    id: 'chunk-default',
    tokenCount: 4,
    updatedAt: '2026-07-03T08:10:00.000Z',
    ...overrides,
  };
}
