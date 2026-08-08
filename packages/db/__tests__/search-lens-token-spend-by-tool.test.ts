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
  '../../../.brainstrike/lenses/token-spend-by-tool.sql'
);

describe('token-spend-by-tool lens', () => {
  let db: PGlite;
  let service: AgentSqlService;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    service = new AgentSqlService(db);
    await db.query(
      `INSERT INTO brainstrike_tool_call_telemetry
        (id, thread_id, run_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup)
       VALUES
        ('1', 'thread', 'run', 'grepSearch', '2026-08-07T10:00:00Z', 100, false, true, false),
        ('2', 'thread', 'run', 'grepSearch', '2026-08-07T11:00:00Z', 300, true, false, true),
        ('3', 'thread', 'run', 'readWorkspaceFile', '2026-08-07T12:00:00Z', 50, false, NULL, false),
        ('4', 'thread', 'run', 'grepSearch', '2026-08-08T12:00:00Z', 999, false, false, false)`
    );
  });

  afterEach(async () => db.close());

  it('parses and aggregates the inclusive bound window', { timeout: 120_000 }, async () => {
    const parsed = parseLensFile('token-spend-by-tool.sql', readFileSync(LENS_PATH, 'utf8'));
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
      'calls',
      'total_model_facing_chars',
      'avg_model_facing_chars',
      'truncation_hit_rate',
      'zero_match_rate',
      'pages_per_search_proxy',
    ]);
    // pages_per_search_proxy is an actual pages-per-search count (first pages
    // + follow-ups, over first pages): grepSearch has one first page (row 1)
    // and one follow-up (row 2) in-window, so 1 search yielded 2 pages — not
    // the pre-fix off-by-one value of 1 (review fix).
    expect(result.rows).toEqual([
      ['grepSearch', 2, 400, 200, 0.5, 0.5, 2],
      ['readWorkspaceFile', 1, 50, 50, 0, null, null],
    ]);
  });

  it('reports pages_per_search_proxy as NULL when the window has only follow-up calls (no first page to anchor the ratio)', async () => {
    await db.query(
      `INSERT INTO brainstrike_tool_call_telemetry
        (id, thread_id, run_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup)
       VALUES
        ('5', 'thread', 'run', 'globWorkspace', '2026-08-07T10:30:00Z', 40, false, false, true)`
    );
    const parsed = parseLensFile('token-spend-by-tool.sql', readFileSync(LENS_PATH, 'utf8'));
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const values = coerceLensValues(parsed.lens.params, [
      '2026-08-07T10:15:00Z',
      '2026-08-07T10:45:00Z',
    ]);
    if (!values.ok) {
      throw new Error(values.error);
    }
    const result = await service.query(parsed.lens.sql, { params: values.values });

    expect(result.rows).toEqual([['globWorkspace', 1, 40, 40, 0, 0, null]]);
  });
});
