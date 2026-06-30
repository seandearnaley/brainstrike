import { describe, expect, it } from 'vitest';

import {
  ASSISTANT_RUN_EVENTS_TABLE,
  ASSISTANT_THREAD_RUNS_TABLE,
  buildAppendAssistantRunEventQuery,
  buildCompleteAssistantThreadRunQuery,
} from '../assistant-run-persistence';

describe('assistant run persistence queries', () => {
  const occurredAt = new Date('2026-04-24T10:00:00.000Z');
  const now = new Date('2026-04-24T10:00:05.000Z');

  it('builds the PGlite run-event append query with Postgres placeholders and Date params', () => {
    const query = buildAppendAssistantRunEventQuery({
      detail: 'Loaded two chunks',
      durationMs: 42,
      eventId: 'event-1',
      kind: 'tool.completed',
      label: 'Tool completed',
      metadataJson: '{"toolName":"brainstrike.queryEmbeddingSpace"}',
      now,
      occurredAt,
      runId: 'run-1',
      runtimeEngine: 'pglite',
      sequence: 7,
      status: 'completed',
    });

    expect(query.sql).toContain(`INSERT INTO ${ASSISTANT_RUN_EVENTS_TABLE}`);
    expect(query.sql).toContain(`FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs`);
    expect(query.sql).toContain('$8::jsonb');
    expect(query.sql).toContain('EXCLUDED.sequence');
    expect(query.sql).not.toContain('?');
    expect(query.params).toEqual([
      'event-1',
      'run-1',
      7,
      'tool.completed',
      'completed',
      'Tool completed',
      'Loaded two chunks',
      '{"toolName":"brainstrike.queryEmbeddingSpace"}',
      42,
      occurredAt,
      now,
      now,
    ]);
  });

  it('builds the Turso run-event append query with SQLite placeholders and ISO params', () => {
    const query = buildAppendAssistantRunEventQuery({
      detail: null,
      durationMs: null,
      eventId: 'event-turso',
      kind: 'run.started',
      label: 'Assistant run started',
      metadataJson: null,
      now,
      occurredAt,
      runId: 'run-turso',
      runtimeEngine: 'turso',
      sequence: 3,
      status: 'running',
    });

    expect(query.sql).toContain(`INSERT INTO ${ASSISTANT_RUN_EVENTS_TABLE}`);
    expect(query.sql).toContain('?');
    expect(query.sql).toContain('excluded.sequence');
    expect(query.sql).not.toMatch(/\$\d|::jsonb|EXCLUDED\./);
    expect(query.params).toEqual([
      'event-turso',
      3,
      'run.started',
      'running',
      'Assistant run started',
      null,
      null,
      null,
      occurredAt.toISOString(),
      now.toISOString(),
      now.toISOString(),
      'run-turso',
    ]);
  });

  it('builds thread-run completion queries with dialect-specific parameter order', () => {
    const pglite = buildCompleteAssistantThreadRunQuery({
      error: 'stream failed',
      now,
      runId: 'run-pglite',
      runtimeEngine: 'pglite',
      status: 'failed',
    });
    const turso = buildCompleteAssistantThreadRunQuery({
      error: null,
      now,
      runId: 'run-turso',
      runtimeEngine: 'turso',
      status: 'completed',
    });

    expect(pglite.sql).toContain(`UPDATE ${ASSISTANT_THREAD_RUNS_TABLE}`);
    expect(pglite.sql).toContain('$2');
    expect(pglite.params).toEqual(['run-pglite', 'failed', 'stream failed', now, now]);

    expect(turso.sql).toContain(`UPDATE ${ASSISTANT_THREAD_RUNS_TABLE}`);
    expect(turso.sql).toContain('?');
    expect(turso.sql).not.toMatch(/\$\d/);
    expect(turso.params).toEqual([
      'completed',
      null,
      now.toISOString(),
      now.toISOString(),
      'run-turso',
    ]);
  });
});
