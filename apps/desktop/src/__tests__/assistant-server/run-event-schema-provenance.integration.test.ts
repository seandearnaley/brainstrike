/**
 * Schema provenance for the MAIN-PROCESS run-event writer.
 *
 * `brainstrike_assistant_run_events` and `brainstrike_assistant_thread_runs` are
 * deliberately NOT migration-backed: both carry ON DELETE CASCADE FKs to parents
 * that no migration creates (the Mastra threads table / the runs row itself), so
 * a numbered migration would either break the migration suite or silently
 * diverge fresh-vs-upgraded installs. They are created ONLY by the renderer's
 * `ASSISTANT_THREAD_RUNS_SCHEMA_SQL` bootstrap.
 *
 * The main process writes into both relations without ever creating them. What
 * makes that safe is NOT startup ordering — it is runId PROVENANCE:
 * `repository.createThreadRun` is the sole producer of a `memory.runId`, and it
 * awaits the schema bootstrap before it can return an id. Every main-process
 * write is gated on `if (runId)`, so the relations always exist by the time the
 * server sees one.
 *
 * These two tests pin the halves of that argument:
 *  1. minting an id really does create the relations (the choke point holds);
 *  2. if the choke point is ever bypassed, the write fails LOUDLY rather than
 *     dropping run events on the floor (no silent degradation).
 *
 * Test 2 is also the CONTROL for test 1: it proves an un-bootstrapped database
 * genuinely breaks this writer, so test 1 asserting "the tables exist" is not a
 * green that can never go red.
 *
 * If a second runId producer is ever added (a server-side background run, a
 * cron/headless run, subagent runs persisted under their own ids), the
 * provenance argument no longer holds and that producer must bootstrap the
 * schema itself. See docs/agents/assistant-persistence.md
 * § RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP.
 */
import type { StreamChunk } from '@brainstrike/agent';
import { MASTRA_MEMORY_SCHEMA_SQL, MASTRA_MEMORY_TABLES } from '@brainstrike/assistant-contract';
import { type DbHandle, wasmLoader } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
// Real repository (the production schema bootstrap + the sole runId-minting
// site). Internal module, same import convention as hook-run-outcome.integration.test.ts.
import { createPgliteAssistantThreadRepository } from '../../../../../packages/app-shell/src/assistant-memory-repository';

type TestDatabase = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

/**
 * The main-process writer resolves its handle through `getDatabase()`, so the
 * un-bootstrapped-database case is driven by pointing that at a bare PGlite.
 */
let mainProcessDatabase: TestDatabase | undefined;
vi.mock('../../db-main', () => ({
  // Throw rather than resolve `undefined`: an unseeded handle is a test-setup
  // mistake, and this file's whole point is telling "schema missing" apart from
  // "handle missing" — a `Cannot read properties of undefined` raised from
  // inside production code would blur exactly that distinction.
  getDatabase: vi.fn(() => {
    if (!mainProcessDatabase) {
      throw new Error('Test did not seed mainProcessDatabase before the main-process write.');
    }
    return Promise.resolve(mainProcessDatabase);
  }),
}));

interface ExistsRow {
  exists: boolean;
}

async function tableExists(db: TestDatabase, tableName: string): Promise<boolean> {
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  const rows = result.rows as readonly ExistsRow[];
  return rows[0]?.exists === true;
}

/**
 * Typed as `StreamChunk` on purpose — an `AsyncIterable<never>` cast would be
 * assignable to any chunk type, so a future change to the run-event contract
 * would leave this fixture compiling against a shape production no longer emits.
 */
async function* singleRunEventStream(): AsyncGenerator<StreamChunk> {
  yield {
    event: {
      id: 'event-1',
      kind: 'run.started',
      label: 'Assistant run started',
      status: 'running',
      timestamp: '2026-07-24T10:00:00.000Z',
    },
    type: 'run-event',
  };
}

describe('main-process run-event schema provenance', () => {
  it('createThreadRun creates the run-event relations before it can return an id', async () => {
    const db = await wasmLoader.createPGlite(`memory://run-event-provenance-mint-${Date.now()}`);
    try {
      // Seed ONLY the Mastra parent tables, so the FK target exists while the
      // assistant bootstrap has not run. `createThreadRun` must therefore be
      // isolated here: routing through `repository.createThread` first would
      // bootstrap the schema itself and make this assertion unfalsifiable.
      await db.exec(MASTRA_MEMORY_SCHEMA_SQL);
      await db.query(
        `INSERT INTO ${MASTRA_MEMORY_TABLES.threads}
          (id, "resourceId", title, metadata, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          'thread-1',
          'workspace-a',
          'Seeded thread',
          JSON.stringify({ source: 'brainstrike' }),
          new Date(),
          new Date(),
        ]
      );
      expect(await tableExists(db, 'brainstrike_assistant_thread_runs')).toBe(false);
      expect(await tableExists(db, 'brainstrike_assistant_run_events')).toBe(false);

      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      const run = await repository.createThreadRun({
        id: 'run-1',
        model: 'gpt-5.2',
        provider: 'openai',
        resourceId: 'workspace-a',
        runtimeKind: 'hosted',
        threadId: 'thread-1',
      });

      // Holding a runId therefore IMPLIES both relations exist — which is the
      // whole safety argument for the un-guarded main-process inserts.
      expect(run.id).toBe('run-1');
      expect(await tableExists(db, 'brainstrike_assistant_thread_runs')).toBe(true);
      expect(await tableExists(db, 'brainstrike_assistant_run_events')).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('throws when the schema was never bootstrapped (never drops run events silently)', async () => {
    const { observeDesktopAssistantRunEvents } = await import('../../assistant-server');
    const db = await wasmLoader.createPGlite(`memory://run-event-provenance-loud-${Date.now()}`);
    mainProcessDatabase = db;
    try {
      expect(await tableExists(db, 'brainstrike_assistant_run_events')).toBe(false);

      const drainStream = async (): Promise<void> => {
        for await (const _chunk of observeDesktopAssistantRunEvents(
          singleRunEventStream(),
          'run-1',
          []
        )) {
          // The chunk is yielded before persistence settles by design; the
          // failure surfaces when the observer flushes its persistence queue.
        }
      };

      await expect(drainStream()).rejects.toThrow(/brainstrike_assistant_run_events/);
    } finally {
      mainProcessDatabase = undefined;
      await db.close();
    }
  });
});
