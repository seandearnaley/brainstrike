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
  '../../../.brainstrike/lenses/experiment-outcome-correlation.sql'
);

function loadLensSql(): string {
  const parsed = parseLensFile(
    'experiment-outcome-correlation.sql',
    readFileSync(LENS_PATH, 'utf8')
  );
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  expect(parsed.lens.params.map((param) => `${param.name}:${param.type}`)).toEqual([
    'since:text',
    'until:text',
  ]);
  return parsed.lens.sql;
}

function coerce(window: readonly [string, string]): (string | number | boolean)[] {
  const parsed = parseLensFile(
    'experiment-outcome-correlation.sql',
    readFileSync(LENS_PATH, 'utf8')
  );
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const values = coerceLensValues(parsed.lens.params, [...window]);
  if (!values.ok) {
    throw new Error(values.error);
  }
  return [...values.values];
}

describe('experiment-outcome-correlation lens (BST-1250)', () => {
  let db: PGlite;
  let service: AgentSqlService;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    service = new AgentSqlService(db);
    // Two enrolled arms plus un-enrolled control-by-default runs; one labeled
    // run per arm, one unlabeled intervention run, one row outside the window.
    await db.query(
      `INSERT INTO brainstrike_assistant_run_treatments
        (run_id, thread_id, resource_id, experiment_id, variant, injection_status, signal_injected, signal_content_hash, created_at)
       VALUES
        ('run-c1', 'thread', 'resource', 'search-policy-2026-08', 'control', 'preference_off', false, NULL, '2026-08-07T10:00:00Z'),
        ('run-i1', 'thread', 'resource', 'search-policy-2026-08', 'signal-on', 'injected', true, 'hash-a', '2026-08-07T10:05:00Z'),
        ('run-i2', 'thread', 'resource', 'search-policy-2026-08', 'signal-on', 'injected', true, 'hash-b', '2026-08-07T10:10:00Z'),
        ('run-cont', 'thread', 'resource', 'search-policy-2026-08', 'signal-on', 'continuation', false, NULL, '2026-08-07T10:12:00Z'),
        ('run-plain', 'thread', 'resource', NULL, NULL, 'preference_off', false, NULL, '2026-08-07T10:15:00Z'),
        ('run-late', 'thread', 'resource', 'search-policy-2026-08', 'control', 'preference_off', false, NULL, '2026-08-08T10:00:00Z')`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_run_outcomes
        (run_id, thread_id, resource_id, verdict, source, labeled_at)
       VALUES
        ('run-c1', 'thread', 'resource', 'failed', 'hook', '2026-08-07T12:00:00Z'),
        ('run-i1', 'thread', 'resource', 'succeeded', 'hook', '2026-08-07T12:00:00Z'),
        ('run-cont', 'thread', 'resource', 'succeeded', 'hook', '2026-08-07T12:00:00Z')`
    );
  });

  afterEach(async () => db.close());

  it('groups outcomes by treatment arm and keeps unlabeled runs visible', async () => {
    const result = await service.query(loadLensSql(), {
      params: coerce(['2026-08-07T10:00:00Z', '2026-08-07T11:00:00Z']),
    });

    expect(result.columns).toEqual([
      'experiment_id',
      'variant',
      'injection_status',
      'runs',
      'labeled_runs',
      'succeeded',
      'mixed',
      'failed',
      'signal_content_hashes',
    ]);
    // The intervention arm shifted signal content mid-window: two distinct
    // hashes must be visible, not silently pooled. The labeled continuation
    // leg (approval/resume) stays visible as its own bucket instead of being
    // silently dropped (review). run-late is outside the window; the
    // un-enrolled row sorts last (NULLS LAST).
    expect(result.rows).toEqual([
      ['search-policy-2026-08', 'control', 'preference_off', 1, 1, 0, 0, 1, 0],
      ['search-policy-2026-08', 'signal-on', 'continuation', 1, 1, 1, 0, 0, 0],
      ['search-policy-2026-08', 'signal-on', 'injected', 2, 1, 1, 0, 0, 2],
      [null, null, 'preference_off', 1, 0, 0, 0, 0, 0],
    ]);
  });
});
