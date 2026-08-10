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
  '../../../.brainstrike/lenses/estimator-calibration.sql'
);

describe('estimator-calibration lens', () => {
  let db: PGlite;
  let service: AgentSqlService;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    service = new AgentSqlService(db);
    await db.query(
      `INSERT INTO brainstrike_token_estimate_calibration
        (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
         final_step_prompt_tokens, model_visible_projection_count,
         resolved_domain_budget_tokens, resolved_transport_budget_tokens, occurred_at)
       VALUES
        ('1', 'thread', 'run-1', 'gpt-5.6-terra', 'openai', 50, 100, 1, 1500, 3000, '2026-08-07T10:00:00Z'),
        ('2', 'thread', 'run-2', 'gpt-5.6-terra', 'openai', 100, 100, 1, 1500, 3000, '2026-08-07T11:00:00Z'),
        ('3', 'thread', 'run-3', 'gpt-5.6-terra', 'openai', 150, 100, 1, 500, 1000, '2026-08-07T12:00:00Z'),
        ('4', 'thread', 'run-4', 'claude-sonnet-4-6', 'anthropic', 10, 0, 1, NULL, NULL, '2026-08-07T12:00:00Z'),
        ('5', 'thread', 'run-5', 'gpt-5.6-terra', 'openai', 999, 100, 1, 1500, 3000, '2026-08-08T12:00:00Z'),
        ('6', 'thread', 'run-6', 'legacy-zero', 'openai', 0, 100, 1, NULL, NULL, '2026-08-07T12:00:00Z'),
        -- BST-1232 regression: a tool-free/resume turn now persists a row
        -- (so the compaction trigger can read prompt_baseline_tokens), but
        -- its estimated_prompt_tokens can still be positive from the static
        -- tool-definition catalog alone (model_visible_projection_count =
        -- 0). Same model/budget-tier group and inside the query window as
        -- rows 1+2, with a ratio (0.4) outside their [0.5, 1] range — if the
        -- lens' eligibility gate regressed, this row would change that
        -- group's samples count and ratio bounds below.
        ('7', 'thread', 'run-7', 'gpt-5.6-terra', 'openai', 40, 100, 0, 1500, 3000, '2026-08-07T11:30:00Z')`
    );
  });

  afterEach(async () => db.close());

  it('parses the checked-in lens and aggregates the inclusive ratio distribution', async () => {
    const parsed = parseLensFile('estimator-calibration.sql', readFileSync(LENS_PATH, 'utf8'));
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
      'model',
      'resolved_domain_budget_tokens',
      'resolved_transport_budget_tokens',
      'samples',
      'ratio_min',
      'ratio_median',
      'ratio_max',
      'ratio_avg',
    ]);
    expect(result.rows).toEqual([
      ['claude-sonnet-4-6', null, null, 0, null, null, null, null],
      ['gpt-5.6-terra', 500, 1000, 1, 1.5, 1.5, 1.5, 1.5],
      ['gpt-5.6-terra', 1500, 3000, 2, 0.5, 0.75, 1, 0.75],
    ]);
  });
});
