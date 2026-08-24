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
// Real repository (the production schema bootstrap + the sole runId-minting
// site). Imported via the assistant-data package
// subpath, same convention as hook-run-outcome.integration.test.ts; placement
// is interim per R04 (BST-984).
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import { observeDesktopAssistantRunEvents } from '../../assistant-server/run-persistence';

type TestDatabase = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

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
    const db = await wasmLoader.createPGlite(`memory://run-event-provenance-loud-${Date.now()}`);
    try {
      expect(await tableExists(db, 'brainstrike_assistant_run_events')).toBe(false);

      // The writer takes its database provider by injection (BST-972 A1), so
      // the un-bootstrapped case is driven by handing it the bare PGlite
      // directly — no module mock needed.
      const drainStream = async (): Promise<void> => {
        for await (const _chunk of observeDesktopAssistantRunEvents(
          singleRunEventStream(),
          'run-1',
          [],
          async () => db
        )) {
          // The chunk is yielded before persistence settles by design; the
          // failure surfaces when the observer flushes its persistence queue.
        }
      };

      await expect(drainStream()).rejects.toThrow(/brainstrike_assistant_run_events/);
    } finally {
      await db.close();
    }
  });
});

describe('duration_ms column contract', () => {
  // Field regression (2026-08-23, 22P02): tool events stamped with FRACTIONAL
  // performance.now() durations failed every persist — "invalid input syntax
  // for type integer: \"15.73333299998194\"" — punching holes in the durable
  // timeline. The producer seam now rounds (withRunEventDuration); this pair
  // pins BOTH halves against the real column: an integer duration persists,
  // and the column genuinely rejects a fractional one — proving the
  // producer-side rounding is load-bearing, not decorative.
  it('persists an integer durationMs and the column rejects a fractional one', async () => {
    const db = await wasmLoader.createPGlite(`memory://run-event-duration-${Date.now()}`);
    try {
      await db.exec(MASTRA_MEMORY_SCHEMA_SQL);
      await db.query(
        `INSERT INTO ${MASTRA_MEMORY_TABLES.threads}
          (id, "resourceId", title, metadata, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          'thread-dur',
          'workspace-a',
          'Seeded thread',
          JSON.stringify({ source: 'brainstrike' }),
          new Date(),
          new Date(),
        ]
      );
      const repository = createPgliteAssistantThreadRepository(db as DbHandle);
      await repository.createThreadRun({
        id: 'run-dur',
        model: 'gpt-5.2',
        provider: 'openai',
        resourceId: 'workspace-a',
        runtimeKind: 'hosted',
        threadId: 'thread-dur',
      });

      async function* durationEventStream(): AsyncGenerator<StreamChunk> {
        yield {
          event: {
            durationMs: 16,
            id: 'event-dur-1',
            kind: 'tool.completed',
            label: 'Tool completed',
            status: 'completed',
            timestamp: '2026-08-23T10:00:00.000Z',
          },
          type: 'run-event',
        };
      }
      for await (const _chunk of observeDesktopAssistantRunEvents(
        durationEventStream(),
        'run-dur',
        [],
        async () => db
      )) {
        // drain; persistence settles at flush
      }
      const persisted = await db.query(
        'SELECT duration_ms FROM brainstrike_assistant_run_events WHERE id = $1',
        ['event-dur-1']
      );
      expect((persisted.rows as readonly { duration_ms: number }[])[0]?.duration_ms).toBe(16);

      // CONTROL: the column contract is INTEGER — a raw fractional value is
      // rejected by PGlite itself, which is exactly the 22P02 the field saw.
      await expect(
        db.query(
          `INSERT INTO brainstrike_assistant_run_events
            (id, run_id, resource_id, thread_id, sequence, kind, status, label, duration_ms, occurred_at, created_at, updated_at)
           VALUES ($1, 'run-dur', 'workspace-a', 'thread-dur', 999, 'tool.completed', 'completed', 'Tool completed', $2, NOW(), NOW(), NOW())`,
          ['event-dur-frac', 15.733_332_999_981_94]
        )
      ).rejects.toThrow(/invalid input syntax for type integer/);
    } finally {
      await db.close();
    }
  });
});
