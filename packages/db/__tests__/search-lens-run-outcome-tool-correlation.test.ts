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
    const parsed = parseLensFile(
      'run-outcome-tool-correlation.sql',
      readFileSync(LENS_PATH, 'utf8')
    );
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.lens.params.map((param) => `${param.name}:${param.type}`)).toEqual([
      'since:text',
      'until:text',
    ]);
    const values = coerceLensValues(parsed.lens.params, [
      '2026-08-07T10:00:00Z',
      '2026-08-07T12:00:00Z',
    ]);
    if (!values.ok) {
      throw new Error(values.error);
    }
    const result = await service.query(parsed.lens.sql, { params: values.values });

    expect(result.columns).toEqual([
      'tool_id',
      'verdict',
      'runs',
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
      ['grepSearch', 'failed', 1, 2, 400, 1, 0.5, 0.5],
      ['grepSearch', 'succeeded', 1, 1, 200, 0, 0, 0],
      ['grepSearch', 'unlabeled', 1, 1, 50, 0, 1, 0],
      ['readWorkspaceFile', 'succeeded', 1, 1, 80, 0, null, 0],
    ]);
  });

  it('counts distinct runs, not calls, in the runs column', async () => {
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
    const parsed = parseLensFile(
      'run-outcome-tool-correlation.sql',
      readFileSync(LENS_PATH, 'utf8')
    );
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const values = coerceLensValues(parsed.lens.params, [
      '2026-08-07T10:00:00Z',
      '2026-08-07T11:00:00Z',
    ]);
    if (!values.ok) {
      throw new Error(values.error);
    }
    const result = await service.query(parsed.lens.sql, { params: values.values });

    // Three globWorkspace calls across TWO failed runs: runs=2, calls=3.
    expect(result.rows).toEqual([
      ['globWorkspace', 'failed', 2, 3, 60, 0, 2 / 3, 0],
      ['grepSearch', 'failed', 1, 2, 400, 1, 0.5, 0.5],
      ['grepSearch', 'succeeded', 1, 1, 200, 0, 0, 0],
    ]);
  });
});
