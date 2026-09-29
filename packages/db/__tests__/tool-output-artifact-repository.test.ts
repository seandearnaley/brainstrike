import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import {
  TOOL_OUTPUT_ARTIFACT_RETENTION_MS,
  ToolOutputArtifactRepository,
  ToolOutputArtifactStorageError,
} from '../src/repositories/tool-output-artifact-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

describe('ToolOutputArtifactRepository', () => {
  let db: PGlite;
  let now: Date;
  let repository: ToolOutputArtifactRepository;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-tool-output-artifact-repository');
    db = await wasmLoader.createPGlite(dataDir);
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    now = new Date('2026-07-19T12:00:00.000Z');
    repository = new ToolOutputArtifactRepository(db, { now: () => new Date(now) });
  });

  afterEach(async () => {
    await db?.close();
  });

  it('keeps sibling execution identities distinct without widening reader ownership', async () => {
    const input = {
      content: 'first child',
      format: 'text' as const,
      resourceId: 'owner',
      runId: 'host-run',
      threadId: 'root',
      toolCallId: 'reused-call',
    };
    const first = await repository.store({ ...input, executionThreadId: 'child-a' });
    const second = await repository.store({
      ...input,
      content: 'second child',
      executionThreadId: 'child-b',
    });
    expect(second.id).not.toBe(first.id);
    await expect(repository.store({ ...input, executionThreadId: 'child-a' })).resolves.toEqual(
      first
    );
    await expect(
      repository.store({ ...input, content: 'changed', executionThreadId: 'child-a' })
    ).rejects.toThrow('insert returned no reference');
    await expect(
      repository.readRange({
        artifactId: first.id,
        limitBytes: 100,
        offsetByte: 0,
        resourceId: 'owner',
        threadId: 'child-a',
      })
    ).resolves.toEqual({ status: 'not_found' });
    const page = await repository.readRange({
      artifactId: second.id,
      limitBytes: 100,
      offsetByte: 0,
      resourceId: 'owner',
      threadId: 'root',
    });
    expect(page.status).toBe('found');
    if (page.status !== 'found') {
      throw new Error('Missing sibling artifact');
    }
    expect(new TextDecoder().decode(page.bytes)).toBe('second child');
  });

  it('stores exact UTF-8 bytes behind an opaque seven-day reference', async () => {
    const content = 'A\u0000🙂\nB';
    const reference = await repository.store({
      content,
      format: 'text',
      resourceId: 'workspace-a',
      runId: 'run-a',
      threadId: 'thread-a',
      toolCallId: 'call-a',
    });

    expect(reference).toMatchObject({
      byteLength: new TextEncoder().encode(content).byteLength,
      expiresAt: new Date(now.getTime() + TOOL_OUTPUT_ARTIFACT_RETENTION_MS).toISOString(),
      format: 'text',
    });
    expect(reference.id).toMatch(/^[A-Za-z0-9_-]+$/u);

    const stored = await db.query<{ content: Uint8Array }>(
      `SELECT content
       FROM brainstrike_assistant_tool_output_artifacts
       WHERE id = $1`,
      [reference.id]
    );
    expect(Array.from(stored.rows[0]?.content ?? [])).toEqual(
      Array.from(new TextEncoder().encode(content))
    );
  });

  it('reads bounded byte ranges only within the owning workspace and thread', async () => {
    const reference = await repository.store({
      content: 'A\u0000🙂\nB',
      format: 'text',
      resourceId: 'workspace-a',
      runId: 'run-a',
      threadId: 'thread-a',
      toolCallId: 'call-a',
    });

    await expect(
      repository.readRange({
        artifactId: reference.id,
        limitBytes: 5,
        offsetByte: 1,
        resourceId: 'workspace-b',
        threadId: 'thread-a',
      })
    ).resolves.toEqual({ status: 'not_found' });
    await expect(
      repository.readRange({
        artifactId: reference.id,
        limitBytes: 5,
        offsetByte: 1,
        resourceId: 'workspace-a',
        threadId: 'thread-b',
      })
    ).resolves.toEqual({ status: 'not_found' });

    const result = await repository.readRange({
      artifactId: reference.id,
      limitBytes: 5,
      offsetByte: 1,
      resourceId: 'workspace-a',
      threadId: 'thread-a',
    });
    expect(result).toEqual({
      bytes: new Uint8Array([0, 240, 159, 153, 130]),
      endByte: 6,
      offsetByte: 1,
      reference,
      status: 'found',
    });
  });

  it('reports expiry without returning content and purges in bounded batches', async () => {
    const expired = await repository.store({
      content: 'old',
      format: 'text',
      resourceId: 'workspace-a',
      runId: 'run-old',
      threadId: 'thread-a',
      toolCallId: 'call-old',
    });
    now = new Date('2026-07-20T12:00:00.000Z');
    const active = await repository.store({
      content: '{"fresh":true}',
      format: 'json',
      resourceId: 'workspace-a',
      runId: 'run-new',
      threadId: 'thread-a',
      toolCallId: 'call-new',
    });
    now = new Date('2026-07-26T12:00:00.000Z');

    await expect(
      repository.readRange({
        artifactId: expired.id,
        limitBytes: 4,
        offsetByte: 0,
        resourceId: 'workspace-a',
        threadId: 'thread-a',
      })
    ).resolves.toEqual({ reference: expired, status: 'expired' });

    await expect(repository.purgeExpired({ limit: 1 })).resolves.toBe(1);
    await expect(repository.purgeExpired({ limit: 1 })).resolves.toBe(0);
    const remaining = await db.query<{ id: string }>(
      'SELECT id FROM brainstrike_assistant_tool_output_artifacts'
    );
    expect(remaining.rows).toEqual([{ id: active.id }]);
  });

  it('makes exact replay idempotent but fails visibly for conflicting replay and storage errors', async () => {
    const input = {
      content: 'result',
      format: 'text' as const,
      resourceId: 'workspace-a',
      runId: 'run-a',
      threadId: 'thread-a',
      toolCallId: 'call-a',
    };
    const first = await repository.store(input);
    await expect(repository.store(input)).resolves.toEqual(first);
    await expect(repository.store({ ...input, content: 'different' })).rejects.toMatchObject({
      name: 'ToolOutputArtifactStorageError',
      operation: 'store',
    });

    await db.close();
    await expect(repository.store({ ...input, toolCallId: 'call-b' })).rejects.toBeInstanceOf(
      ToolOutputArtifactStorageError
    );
    db = null as never;
  });

  it('rejects invalid ranges before querying storage', async () => {
    await expect(
      repository.readRange({
        artifactId: 'opaque',
        limitBytes: 0,
        offsetByte: 0,
        resourceId: 'workspace-a',
        threadId: 'thread-a',
      })
    ).rejects.toThrow(/limitBytes/u);
    await expect(
      repository.readRange({
        artifactId: 'opaque',
        limitBytes: 4,
        offsetByte: -1,
        resourceId: 'workspace-a',
        threadId: 'thread-a',
      })
    ).rejects.toThrow(/offsetByte/u);
  });

  it('rejects owner ids that exceed the index-safe UTF-8 byte limit', async () => {
    await expect(
      repository.store({
        content: 'result',
        format: 'text',
        resourceId: '🙂'.repeat(129),
        runId: 'run-a',
        threadId: 'thread-a',
        toolCallId: 'call-a',
      })
    ).rejects.toThrow(/resourceId.*512 UTF-8 bytes/u);
  });
});
