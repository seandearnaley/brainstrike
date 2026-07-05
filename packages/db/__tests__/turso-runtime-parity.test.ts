import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';
import {
  runCollectionStatsRefreshContract,
  runEffectiveMembershipContract,
  runEmbeddingSetsCrudAndStatsSeedContract,
  runFileChunkPersistenceContract,
  runFileRecordPersistenceContract,
  runGrepCandidatesContract,
  runJobQueueLifecycleContract,
  runManagedCacheApplyContract,
  runManagedCacheIdentityContract,
  runQuickOpenNameGramContract,
  runTokenCacheContract,
  runVectorSearchContract,
  runViewFilterPresetsContract,
} from './helpers/turso-runtime-parity-contracts.js';

/**
 * Node lane of the Turso runtime parity contract (A6 browser-cutover gate).
 *
 * Runs the SHARED contract bodies from helpers/turso-runtime-parity-contracts
 * against the native Turso owner client. The browser lane
 * (turso-browser-runtime-parity.browser.test.ts) runs the IDENTICAL bodies
 * against the real @tursodatabase/database-wasm FIFO client over OPFS, so any
 * behavioral divergence between the two runtimes fails one lane. The deeper
 * per-repository node suites (turso-*-repository.test.ts,
 * job-queue-turso-runtime.test.ts, turso-managed-cache-batch.test.ts) remain
 * the authority for dialect/SQL-shape coverage.
 */
describe('Turso runtime parity contracts (native owner client)', () => {
  let client: TursoOwnerClient;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-runtime-parity-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('embedding sets: CRUD + seeded indexing stats', async () => {
    await runEmbeddingSetsCrudAndStatsSeedContract(client);
  });

  it('file records: persistence, validation, bulk import dedupe', async () => {
    await runFileRecordPersistenceContract(client);
  });

  it('file records: managed-cache identity + stat metadata', async () => {
    await runManagedCacheIdentityContract(client);
  });

  it('file chunks: non-search persistence + embedding update validation', async () => {
    await runFileChunkPersistenceContract(client);
  });

  it('file chunks: effective embedding-set membership (explicit wins, NULL inherits)', async () => {
    await runEffectiveMembershipContract(client);
  });

  it('quick-open: name-gram lookup stays consistent across writes', async () => {
    await runQuickOpenNameGramContract(client);
  });

  it('grep: gram-indexed candidate selection with filters and escapes', async () => {
    await runGrepCandidatesContract(client);
  });

  it('vector: vector32 searchSimilar with set/root/path filters and inheritance', async () => {
    await runVectorSearchContract(client);
  });

  it('view filter presets: seeded defaults + CRUD + protected deletes', async () => {
    await runViewFilterPresetsContract(client);
  });

  it('file token cache: upserts, batch lookups, folder-scoped deletes', async () => {
    await runTokenCacheContract(client);
  });

  it('job queue: enqueue → claim/lease → heartbeat → fail/retry → complete → counts', async () => {
    await runJobQueueLifecycleContract(client);
  });

  it('managed cache: import/replace/invalidate through the batch apply path', async () => {
    await runManagedCacheApplyContract(client);
  });

  it('collection stats: dirty marking + refresh with inherited ownership', async () => {
    await runCollectionStatsRefreshContract(client);
  });
});
