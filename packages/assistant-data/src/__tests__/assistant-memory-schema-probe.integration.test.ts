/**
 * The assistant memory schema PROBE (BST-1651).
 *
 * The repository used to `exec` a ~590-line `CREATE TABLE IF NOT EXISTS` mirror
 * of the migrations on first use per database handle. On a migrated database
 * the `IF NOT EXISTS` never fired, so any divergence between the mirror and the
 * migrations was invisible until a user hit a column one of them had shaped
 * differently — a silent, latent corruption with no error pointing at its cause.
 *
 * Migrations 117/118 now own that schema outright and the repository probes for
 * it with `to_regclass`, which returns NULL for an absent relation rather than
 * raising. A missing relation means migrations did not run, and that must be a
 * loud, named failure — never a create-it-if-absent fallback, which is what
 * would silently rebuild the divergence this change exists to remove.
 */
import { migrate } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import {
  AssistantMemorySchemaMissingError,
  createPgliteAssistantThreadRepository,
} from '../assistant-memory-repository';
import { createMigratedTestPGlite, createTestPGlite } from './helpers/test-pglite';

let dataDirCounter = 0;

function nextDataDir(prefix: string): string {
  dataDirCounter += 1;
  return `memory://${prefix}-${dataDirCounter}`;
}

describe('assistant memory schema probe (real PGlite)', () => {
  it('throws a named error naming the missing relations on an un-migrated database', async () => {
    const db = await createTestPGlite(nextDataDir('schema-probe-bare'));
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    const rejection = await repository.listThreads('workspace-a').then(
      () => null,
      (error: unknown) => error
    );

    expect(rejection).toBeInstanceOf(AssistantMemorySchemaMissingError);
    const error = rejection as AssistantMemorySchemaMissingError;
    expect(error.missingRelations).toContain('mastra_threads');
    expect(error.missingRelations).toContain('brainstrike_assistant_thread_runs');
    expect(error.missingRelations).toContain('brainstrike_assistant_run_events');
    expect(error.message).toContain('run migrations');
  });

  it('creates nothing when the probe fails — no silent bootstrap of the schema', async () => {
    const db = await createTestPGlite(nextDataDir('schema-probe-no-create'));
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    await expect(repository.listThreads('workspace-a')).rejects.toBeInstanceOf(
      AssistantMemorySchemaMissingError
    );

    const relations = await db.query<{ present: string | null }>(
      `SELECT to_regclass('public.brainstrike_assistant_thread_runs')::text AS present`
    );
    expect(relations.rows[0]?.present).toBeNull();
  });

  it('re-probes after a failure rather than caching the negative answer', async () => {
    const db = await createTestPGlite(nextDataDir('schema-probe-reprobe'));
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    await expect(repository.listThreads('workspace-a')).rejects.toBeInstanceOf(
      AssistantMemorySchemaMissingError
    );

    await migrate(db);

    const thread = await repository.createThread('workspace-a');
    expect(thread.resourceId).toBe('workspace-a');
  });

  it('works against a migrated database', async () => {
    const db = await createMigratedTestPGlite(nextDataDir('schema-probe-migrated'));
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);

    const thread = await repository.createThread('workspace-a', 'Probe');
    const threads = await repository.listThreads('workspace-a');

    expect(threads.map((row) => row.id)).toEqual([thread.id]);
  });
});
