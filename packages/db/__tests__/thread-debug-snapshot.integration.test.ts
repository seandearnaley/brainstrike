import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readThreadDebugSnapshot } from '../src/repositories/thread-debug-snapshot.js';
import { createMigratedTestDb } from './helpers/migrated-test-db';

describe('ordinary web thread debug snapshot', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await createMigratedTestDb();
    await db.exec(`INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', now(), now()), ('other', 'owner', 'Other', now(), now());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at)
      VALUES ('success', 'owner', 'root', 'openai', 'test', 'hosted', 'completed', now(), now(), now()),
        ('failure', 'owner', 'root', 'openai', 'test', 'hosted', 'failed', now(), now(), now()),
        ('other-run', 'owner', 'other', 'openai', 'test', 'hosted', 'completed', now(), now(), now());
      INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
      SELECT 'message-' || n, 'root', jsonb_build_object('format', 2, 'parts', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'retained-' || n))),
        'assistant', 'v2', now(), 'owner' FROM generate_series(1, 60) n;
      INSERT INTO brainstrike_assistant_run_events
        (id, run_id, resource_id, thread_id, sequence, kind, status, label, occurred_at, created_at, updated_at)
      SELECT 'event-' || n, 'success', 'owner', 'root', n, 'tool.completed', 'completed', 'Tool', now(), now(), now()
      FROM generate_series(1, 600) n;
      INSERT INTO brainstrike_assistant_run_usage
        (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, run_kind)
      VALUES ('usage', 'root', 'success', 'owner', 'test', 'openai', 10, 5, 'chat');`);
  });
  afterEach(async () => {
    await db.close();
  });

  it('exports all retained ordinary history without another conversation or a delegated ledger', async () => {
    const snapshot = await readThreadDebugSnapshot(db, 'root');
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(snapshot.sections['threads']?.map((row) => row['id'])).toEqual(['root']);
    expect(snapshot.sections['runs']).toHaveLength(2);
    expect(snapshot.sections['messages']).toHaveLength(60);
    expect(snapshot.sections['events']).toHaveLength(600);
    expect(snapshot.sections['events']?.at(-1)?.['sequence']).toBe(600);
    expect(snapshot.sections['usage']).toMatchObject([{ input_tokens: 10, output_tokens: 5 }]);
    expect(JSON.stringify(snapshot)).not.toContain('other-run');
    expect(snapshot.sections).not.toHaveProperty('conversations');
    expect(snapshot.sections).not.toHaveProperty('continuations');
  });

  it('exports only the selected saved thread and rejects a missing one', async () => {
    expect((await readThreadDebugSnapshot(db, 'other')).sections['threads']).toHaveLength(1);
    await expect(readThreadDebugSnapshot(db, 'missing')).rejects.toThrow('has not been saved yet');
  });

  it('refuses an ownership change between identity and snapshot reads', async () => {
    let reads = 0;
    await expect(
      readThreadDebugSnapshot(
        {
          query: async (sql, values) => {
            reads += 1;
            if (reads === 2) {
              await db.query(
                `UPDATE mastra_threads SET "resourceId" = 'revoked' WHERE id = 'root'`
              );
            }
            return await db.query(sql, values ? [...values] : undefined);
          },
        },
        'root'
      )
    ).rejects.toThrow('ownership has changed');
  });
});
