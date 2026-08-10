import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coerceLensValues, parseLensFile } from '@brainstrike/assistant-contract';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSqlService } from '../src/search/agent-sql-service.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const LENS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.brainstrike/lenses/self-improvement-signal.sql'
);

function coerce(values: readonly [string, string, string]): (string | number | boolean)[] {
  const parsed = parseLensFile('self-improvement-signal.sql', readFileSync(LENS_PATH, 'utf8'));
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const coerced = coerceLensValues(parsed.lens.params, [...values]);
  if (!coerced.ok) {
    throw new Error(coerced.error);
  }
  return [...coerced.values];
}

function loadLensSql(): string {
  const parsed = parseLensFile('self-improvement-signal.sql', readFileSync(LENS_PATH, 'utf8'));
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  expect(parsed.lens.params.map((param) => `${param.name}:${param.type}`)).toEqual([
    'since:text',
    'until:text',
    'top_n:integer',
  ]);
  return parsed.lens.sql;
}

describe('self-improvement-signal lens', () => {
  let db: PGlite;
  let service: AgentSqlService;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    service = new AgentSqlService(db);
    // Six tools so top_n=5 drops exactly one; scores chosen distinct so
    // ordering is fully determined before the tool_id tiebreak, plus three
    // zero-score tools to prove the tiebreak itself.
    await db.query(
      `INSERT INTO brainstrike_tool_call_telemetry
        (id, thread_id, run_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup)
       VALUES
        ('1', 'thread', 'run', 'grepSearch', '2026-08-07T10:00:00Z', 100, true, true, false),
        ('2', 'thread', 'run', 'grepSearch', '2026-08-07T10:30:00Z', 300, false, false, true),
        ('3', 'thread', 'run', 'executeCommand', '2026-08-07T10:35:00Z', 300, true, NULL, false),
        ('4', 'thread', 'run', 'globWorkspace', '2026-08-07T10:40:00Z', 80, true, true, false),
        ('5', 'thread', 'run', 'readWorkspaceFile', '2026-08-07T10:45:00Z', 500, false, NULL, false),
        ('6', 'thread', 'run', 'readWorkspaceFile', '2026-08-07T10:50:00Z', 500, false, NULL, false),
        ('7', 'thread', 'run', 'runPython', '2026-08-07T10:55:00Z', 10, false, NULL, false),
        ('8', 'thread', 'run', 'webFetch', '2026-08-07T10:58:00Z', 50, false, false, false),
        ('9', 'thread', 'run', 'grepSearch', '2026-08-08T09:00:00Z', 9999, true, true, false)`
    );
  });

  afterEach(async () => db.close());

  it('ranks tools by waste score and keeps the top N', { timeout: 120_000 }, async () => {
    const sql = loadLensSql();
    const result = await service.query(sql, {
      params: coerce(['2026-08-07T10:00:00Z', '2026-08-07T11:00:00Z', '5']),
    });

    expect(result.columns).toEqual([
      'tool_id',
      'calls',
      'total_model_facing_chars',
      'truncation_hit_rate',
      'zero_match_rate',
      'waste_score',
    ]);
    // Hand-computed scores (row 9 is outside the window):
    //   grepSearch:        400 * (0.5 + 0.5) = 400
    //   executeCommand:    300 * (1 + 0)     = 300   (zero_match NULL → term folds to 0)
    //   globWorkspace:      80 * (1 + 1)     = 160
    //   readWorkspaceFile: 1000 * (0 + 0)    = 0
    //   runPython:           10 * (0 + 0)    = 0
    //   webFetch:            50 * (0 + 0)    = 0     ← dropped: top_n=5, tool_id tiebreak
    // The zero_match_rate COLUMN stays NULL for tools that never report it;
    // only the score folds the missing term to 0.
    expect(result.rows).toEqual([
      ['grepSearch', 2, 400, 0.5, 0.5, 400],
      ['executeCommand', 1, 300, 1, null, 300],
      ['globWorkspace', 1, 80, 1, 1, 160],
      ['readWorkspaceFile', 2, 1000, 0, null, 0],
      ['runPython', 1, 10, 0, null, 0],
    ]);
  });

  it('honors top_n as the ranked cutoff', async () => {
    const sql = loadLensSql();
    const result = await service.query(sql, {
      params: coerce(['2026-08-07T10:00:00Z', '2026-08-07T11:00:00Z', '2']),
    });

    expect(result.rows).toEqual([
      ['grepSearch', 2, 400, 0.5, 0.5, 400],
      ['executeCommand', 1, 300, 1, null, 300],
    ]);
  });

  it('merges dotted and bare spellings of the same logical tool', async () => {
    // An isolated window slice holding one dotted and one bare call: they
    // must land in ONE bucket, because a split would halve the waste score
    // and can silently push the genuinely-worst tool out of the top N.
    await db.query(
      `INSERT INTO brainstrike_tool_call_telemetry
        (id, thread_id, run_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup)
       VALUES
        ('10', 'thread', 'run', 'brainstrike.grepSearch', '2026-08-07T11:30:00Z', 100, true, true, false),
        ('11', 'thread', 'run', 'grepSearch', '2026-08-07T11:45:00Z', 300, false, false, false)`
    );
    const sql = loadLensSql();
    const result = await service.query(sql, {
      params: coerce(['2026-08-07T11:30:00Z', '2026-08-07T12:00:00Z', '5']),
    });

    expect(result.rows).toEqual([['grepSearch', 2, 400, 0.5, 0.5, 400]]);
  });
});
