import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addLogListener } from '@brainstrike/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrainstrikeDbTransactionClient } from '../src/architecture/brainstrike-db-client-contract.js';
import { replaceGrepContentIndex } from '../src/search/grep-content-grams.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

describe('replaceGrepContentIndex', () => {
  let client: TursoOwnerClient;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-grep-content-grams-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    await client.exec(
      `INSERT INTO file_records (id, path, name, content, content_hash, created_at, updated_at, size, token_count)
       VALUES ('file-1', 'src/index.ts', 'index.ts', 'x', 'h1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 1)`
    );
    await client.exec(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ('chunk-1', 'file-1', 0, 'placeholder', 'h1', 1, 'code', 11, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('replaces grams correctly on normal content changes (no pre-existing collision)', async () => {
    await client.transaction(async (tx) => {
      await replaceGrepContentIndex(tx, 'chunk-1', 'alpha beta gamma');
    });
    const first = await client.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM file_chunk_content_grams WHERE file_chunk_id = ?',
      ['chunk-1']
    );
    expect(Number(first.rows[0]?.n)).toBeGreaterThan(0);

    // 'alpha beta gamma' -> 'completely different text here' deliberately
    // share coincidental grams (e.g. 'et', from both "beta" and "text"/
    // "different"). The old row for 'alp' (unique to the first string) must
    // be gone, AND the overlapping 'et' must be present exactly once — this
    // proves the DELETE-then-INSERT cycle handles gram overlap correctly,
    // not just non-overlapping grams.
    await client.transaction(async (tx) => {
      await replaceGrepContentIndex(tx, 'chunk-1', 'completely different text here');
    });
    const stale = await client.query<{ gram: string }>(
      'SELECT gram FROM file_chunk_content_grams WHERE file_chunk_id = ? AND gram = ?',
      ['chunk-1', 'alp']
    );
    expect(stale.rows).toEqual([]);
    // The content is already all-lowercase, so the case-sensitive AND
    // case-insensitive passes both produce 'et' — two distinct rows
    // (different case_sensitive values, same gram string). Filter to one
    // to assert that variant exists exactly once (not zero, not duplicated).
    const overlapping = await client.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM file_chunk_content_grams WHERE file_chunk_id = ? AND case_sensitive = ? AND gram = ?',
      ['chunk-1', 1, 'et']
    );
    expect(Number(overlapping.rows[0]?.n)).toBe(1);
  });

  it('does not throw when a stale row for the SAME (file_chunk_id, case_sensitive, gram) tuple survives ahead of the insert (core regression proof against the real Turso engine)', async () => {
    // Simulate the observed live-repro state: a prior COMPLETE gram write for
    // this exact chunk id exists and was NOT cleared by the preceding DELETE
    // (mechanism unknown; see the comment in grep-content-grams.ts). Insert
    // one row directly, bypassing the DELETE this test does not invoke, so
    // the insert loop's own ON CONFLICT DO NOTHING is genuinely exercised
    // against a real pre-existing row rather than one it just deleted itself.
    await client.exec(
      'INSERT INTO file_chunk_content_grams (file_chunk_id, case_sensitive, gram) VALUES (?, ?, ?)',
      ['chunk-1', 1, 'alp']
    );

    await expect(
      client.transaction(async (tx) => {
        await tx.exec('DELETE FROM file_chunk_content_index WHERE file_chunk_id = ?', ['chunk-1']);
        await tx.exec(
          'INSERT INTO file_chunk_content_index (file_chunk_id, normalized_content) VALUES (?, ?)',
          ['chunk-1', 'alpha beta gamma']
        );
        // Mirrors replaceGrepContentIndex's own insert statement exactly,
        // WITHOUT its preceding grams DELETE, to prove the ON CONFLICT DO
        // NOTHING clause on this real engine tolerates a duplicate primary
        // key instead of throwing.
        await tx.exec(
          `INSERT INTO file_chunk_content_grams (file_chunk_id, case_sensitive, gram)
           VALUES (?, ?, ?)
           ON CONFLICT (file_chunk_id, case_sensitive, gram) DO NOTHING`,
          ['chunk-1', 1, 'alp']
        );
      })
    ).resolves.toBeUndefined();

    const rows = await client.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM file_chunk_content_grams WHERE file_chunk_id = ? AND case_sensitive = ? AND gram = ?',
      ['chunk-1', 1, 'alp']
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it('warns (does not throw) when the post-insert gram count does not match what was attempted', async () => {
    const warnings: unknown[] = [];
    const stop = addLogListener((record) => {
      if (record.scope === 'DB:GrepContentGrams' && record.level === 'warn') {
        warnings.push(record);
      }
    });
    try {
      const scriptedClient: BrainstrikeDbTransactionClient = {
        exec: async () => undefined,
        query: async () => ({ rows: [{ n: 0 }] }) as never,
      };
      await replaceGrepContentIndex(scriptedClient, 'chunk-mismatch', 'alpha beta gamma');
      expect(warnings.length).toBe(1);
    } finally {
      stop();
    }
  });

  it('warns (does not throw) when the verification query itself fails', async () => {
    const warnings: unknown[] = [];
    const stop = addLogListener((record) => {
      if (record.scope === 'DB:GrepContentGrams' && record.level === 'warn') {
        warnings.push(record);
      }
    });
    try {
      let queryCount = 0;
      const scriptedClient: BrainstrikeDbTransactionClient = {
        exec: async () => undefined,
        query: async () => {
          queryCount += 1;
          throw new Error('simulated verification query failure');
        },
      };
      await expect(
        replaceGrepContentIndex(scriptedClient, 'chunk-query-failure', 'alpha beta gamma')
      ).resolves.toBeUndefined();
      expect(queryCount).toBe(1);
      expect(warnings.length).toBe(1);
    } finally {
      stop();
    }
  });
});
