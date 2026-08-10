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
  '../../../.brainstrike/lenses/run-outcome-tool-correlation.sql'
);

function loadLensSql(): { sql: string; values: (string | number | boolean)[] } {
  const parsed = parseLensFile('run-outcome-tool-correlation.sql', readFileSync(LENS_PATH, 'utf8'));
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  expect(parsed.lens.params.map((param) => `${param.name}:${param.type}`)).toEqual([
    'since:text',
    'until:text',
  ]);
  return { sql: parsed.lens.sql, values: [] };
}

function coerce(window: readonly [string, string]): (string | number | boolean)[] {
  const parsed = parseLensFile('run-outcome-tool-correlation.sql', readFileSync(LENS_PATH, 'utf8'));
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const values = coerceLensValues(parsed.lens.params, [...window]);
  if (!values.ok) {
    throw new Error(values.error);
  }
  return [...values.values];
}

describe('run-outcome-tool-correlation lens', () => {
  let db: PGlite;
  let service: AgentSqlService;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    service = new AgentSqlService(db);
    await db.query(
      `INSERT INTO brainstrike_assistant_run_outcomes
        (run_id, thread_id, resource_id, verdict, source, labeled_at)
       VALUES
        ('run-fail', 'thread', 'resource', 'failed', 'user', '2026-08-07T12:00:00Z'),
        ('run-good', 'thread', 'resource', 'succeeded', 'user', '2026-08-07T12:00:00Z')`
    );
    await db.query(
      `INSERT INTO brainstrike_tool_call_telemetry
        (id, thread_id, run_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup)
       VALUES
        ('1', 'thread', 'run-fail', 'grepSearch', '2026-08-07T10:00:00Z', 100, true, true, false),
        ('2', 'thread', 'run-fail', 'grepSearch', '2026-08-07T10:30:00Z', 300, true, false, true),
        ('3', 'thread', 'run-good', 'grepSearch', '2026-08-07T11:00:00Z', 200, false, false, false),
        ('4', 'thread', 'run-none', 'grepSearch', '2026-08-07T11:30:00Z', 50, false, true, false),
        ('5', 'thread', 'run-good', 'readWorkspaceFile', '2026-08-07T11:45:00Z', 80, false, NULL, false),
        ('6', 'thread', 'run-fail', 'grepSearch', '2026-08-08T09:00:00Z', 999, true, true, true)`
    );
  });

  afterEach(async () => db.close());

  it('buckets telemetry by tool and verdict, keeping unlabeled runs', {
    timeout: 120_000,
  }, async () => {
    const { sql } = loadLensSql();
    const result = await service.query(sql, {
      params: coerce(['2026-08-07T10:00:00Z', '2026-08-07T12:00:00Z']),
    });

    expect(result.columns).toEqual([
      'tool_id',
      'verdict',
      'runs',
      'verdict_total_runs',
      'verdict_run_share',
      'calls',
      'total_model_facing_chars',
      'truncation_hit_rate',
      'zero_match_rate',
      'followup_call_rate',
    ]);
    // Row 6 sits outside the window and must not shift any bucket. run-none
    // has no outcome row: the LEFT JOIN buckets it as 'unlabeled' instead of
    // dropping it — a correlation lens that silently excluded unlabeled runs
    // would compare labeled runs against nothing.
    expect(result.rows).toEqual([
      ['grepSearch', 'failed', 1, 1, 1, 2, 400, 1, 0.5, 0.5],
      ['grepSearch', 'succeeded', 1, 1, 1, 1, 200, 0, 0, 0],
      ['grepSearch', 'unlabeled', 1, 1, 1, 1, 50, 0, 1, 0],
      ['readWorkspaceFile', 'succeeded', 1, 1, 1, 1, 80, 0, null, 0],
    ]);
  });

  it('divides runs by the per-verdict distinct-run total, not by calls', async () => {
    await db.query(
      `INSERT INTO brainstrike_tool_call_telemetry
        (id, thread_id, run_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup)
       VALUES
        ('7', 'thread', 'run-fail-2', 'globWorkspace', '2026-08-07T10:10:00Z', 10, false, true, false),
        ('8', 'thread', 'run-fail-2', 'globWorkspace', '2026-08-07T10:20:00Z', 20, false, true, false),
        ('9', 'thread', 'run-fail-3', 'globWorkspace', '2026-08-07T10:40:00Z', 30, false, false, false)`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_run_outcomes
        (run_id, thread_id, resource_id, verdict, source, labeled_at)
       VALUES
        ('run-fail-2', 'thread', 'resource', 'failed', 'edit_revert', '2026-08-07T12:00:00Z'),
        ('run-fail-3', 'thread', 'resource', 'failed', 'user', '2026-08-07T12:00:00Z')`
    );
    const { sql } = loadLensSql();
    const result = await service.query(sql, {
      params: coerce(['2026-08-07T10:00:00Z', '2026-08-07T11:00:00Z']),
    });

    // Three failed runs total in-window (run-fail, run-fail-2, run-fail-3).
    // globWorkspace appears in two of them (runs=2, calls=3 — distinct runs,
    // not calls); grepSearch in one, so its failed-run share is 1/3 even
    // though it produced two calls. The share is what makes "does this tool
    // correlate with failure?" readable off one row.
    expect(result.rows).toEqual([
      ['globWorkspace', 'failed', 2, 3, 2 / 3, 3, 60, 0, 2 / 3, 0],
      ['grepSearch', 'failed', 1, 3, 1 / 3, 2, 400, 1, 0.5, 0.5],
      ['grepSearch', 'succeeded', 1, 1, 1, 1, 200, 0, 0, 0],
    ]);
  });

  it('normalizes dotted tool ids into the bare spelling before grouping', async () => {
    await db.query(
      `INSERT INTO brainstrike_tool_call_telemetry
        (id, thread_id, run_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup)
       VALUES
        ('10', 'thread', 'run-fail', 'brainstrike.grepSearch', '2026-08-07T10:15:00Z', 100, true, false, false)`
    );
    const { sql } = loadLensSql();
    const result = await service.query(sql, {
      params: coerce(['2026-08-07T10:00:00Z', '2026-08-07T12:00:00Z']),
    });

    // The dotted row merges into the bare grepSearch/failed bucket
    // (calls 2 → 3) instead of surfacing as a separate
    // 'brainstrike.grepSearch' row: the writer stores tool_id verbatim, so
    // both spellings of one logical tool can coexist in a window.
    expect(result.rows).toEqual([
      ['grepSearch', 'failed', 1, 1, 1, 3, 500, 1, 1 / 3, 1 / 3],
      ['grepSearch', 'succeeded', 1, 1, 1, 1, 200, 0, 0, 0],
      ['grepSearch', 'unlabeled', 1, 1, 1, 1, 50, 0, 1, 0],
      ['readWorkspaceFile', 'succeeded', 1, 1, 1, 1, 80, 0, null, 0],
    ]);
  });

  it('is admitted by the cost gate at realistic telemetry volume', async () => {
    await db.query(
      `INSERT INTO brainstrike_tool_call_telemetry
        (id, thread_id, run_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup)
       SELECT
         'bulk-' || g,
         'thread',
         'run-' || (g % 200),
         CASE g % 3
           WHEN 0 THEN 'grepSearch'
           WHEN 1 THEN 'readWorkspaceFile'
           ELSE 'brainstrike.globWorkspace'
         END,
         '2026-08-07T10:00:00Z'::timestamptz + (g || ' seconds')::interval,
         g % 500,
         g % 7 = 0,
         CASE WHEN g % 3 = 2 THEN g % 5 = 0 ELSE NULL END,
         false
       FROM generate_series(1, 2000) g`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_run_outcomes
        (run_id, thread_id, resource_id, verdict, source, labeled_at)
       SELECT
         'run-' || g,
         'thread',
         'resource',
         CASE WHEN g % 2 = 0 THEN 'failed' ELSE 'succeeded' END,
         'user',
         '2026-08-08T00:00:00Z'
       FROM generate_series(0, 49) g
       ON CONFLICT (run_id) DO NOTHING`
    );
    const { sql } = loadLensSql();
    // The point is admission, not the row values: the two-CTE shape must
    // stay under the 50,000 planner-cost ceiling at a realistic 60-day
    // telemetry volume, per the reviewer's ask on the denominator CTE.
    const result = await service.query(sql, {
      params: coerce(['2026-08-07T00:00:00Z', '2026-08-09T00:00:00Z']),
    });
    expect(result.rows.length).toBeGreaterThanOrEqual(3);
  });
});
