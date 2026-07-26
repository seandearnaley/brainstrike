import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import {
  AssistantRunErrorRepository,
  AssistantRunErrorStorageError,
} from '../src/repositories/assistant-run-error-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

describe('AssistantRunErrorRepository', () => {
  let db: PGlite;
  let repository: AssistantRunErrorRepository;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(
      createPGliteTestDataDir('pglite-test-assistant-run-error-repository')
    );
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    await db.exec(`
      CREATE TABLE brainstrike_assistant_thread_runs (
        id TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL,
        thread_id TEXT NOT NULL
      );
      INSERT INTO brainstrike_assistant_thread_runs (id, resource_id, thread_id)
      VALUES ('run-a', 'resource-a', 'thread-a');
    `);
    repository = new AssistantRunErrorRepository(db);
  });

  afterEach(async () => {
    await db?.close();
  });

  it('derives ownership from the durable parent run and round-trips forensics', async () => {
    const error = await repository.record({
      causeChain: [{ message: 'quota exceeded', name: 'APICallError' }],
      code: 'provider_rate_limit',
      httpStatus: 429,
      message: 'The provider rejected the request.',
      occurredAt: new Date('2026-07-26T18:00:00.000Z'),
      providerRequestId: 'req-safe',
      responseHeaders: { 'retry-after': '30', 'x-request-id': 'req-safe' },
      runId: 'run-a',
    });

    expect(error).toEqual({
      causeChain: [{ message: 'quota exceeded', name: 'APICallError' }],
      code: 'provider_rate_limit',
      httpStatus: 429,
      message: 'The provider rejected the request.',
      occurredAt: new Date('2026-07-26T18:00:00.000Z'),
      providerRequestId: 'req-safe',
      resourceId: 'resource-a',
      responseHeaders: { 'retry-after': '30', 'x-request-id': 'req-safe' },
      runId: 'run-a',
      threadId: 'thread-a',
    });
    await expect(repository.getByRunId('run-a')).resolves.toEqual(error);
  });

  it('rejects a missing parent loudly without writing an orphan', async () => {
    await expect(
      repository.record({
        code: 'provider_error',
        occurredAt: new Date('2026-07-26T18:00:00.000Z'),
        runId: 'missing-run',
      })
    ).rejects.toMatchObject({
      name: 'AssistantRunErrorStorageError',
      operation: 'record',
    });

    const rows = await db.query('SELECT run_id FROM brainstrike_assistant_run_errors');
    expect(rows.rows).toEqual([]);
  });

  it('keeps the first terminal classification across competing writers', async () => {
    const first = await repository.record({
      code: 'provider_rate_limit',
      httpStatus: 429,
      occurredAt: new Date('2026-07-26T18:00:00.000Z'),
      runId: 'run-a',
    });
    const competing = await repository.record({
      code: 'watchdog_timeout',
      message: 'A later terminal path also attempted to classify this run.',
      occurredAt: new Date('2026-07-26T18:00:01.000Z'),
      runId: 'run-a',
    });

    expect(competing).toEqual(first);
    await expect(repository.getByRunId('run-a')).resolves.toEqual(first);
  });

  it('does not treat a detached existing row as a valid duplicate', async () => {
    await repository.record({
      code: 'provider_error',
      occurredAt: new Date('2026-07-26T18:00:00.000Z'),
      runId: 'run-a',
    });
    await db.query("DELETE FROM brainstrike_assistant_thread_runs WHERE id = 'run-a'");

    await expect(
      repository.record({
        code: 'watchdog_timeout',
        occurredAt: new Date('2026-07-26T18:00:01.000Z'),
        runId: 'run-a',
      })
    ).rejects.toBeInstanceOf(AssistantRunErrorStorageError);
  });

  it('returns null for an unknown run and surfaces storage failures', async () => {
    await expect(repository.getByRunId('missing-run')).resolves.toBeNull();
    await db.close();
    await expect(repository.getByRunId('run-a')).rejects.toMatchObject({
      name: 'AssistantRunErrorStorageError',
      operation: 'read',
    });
    db = null as never;
  });
});
