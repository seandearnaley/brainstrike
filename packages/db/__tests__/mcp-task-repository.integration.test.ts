import {
  type McpTaskAuthorityLease,
  McpTaskMetadataTooLargeError,
} from '@brainstrike/assistant-contract/mcp-task-store';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { McpTaskRepository } from '../src/repositories/mcp-task-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';
import { createPGliteTestDataDir } from './test-data-dir';

const authorityInput = {
  connectionGeneration: 7,
  principalId: 'linear:user-42',
  resource: 'https://mcp.linear.app/mcp',
  runtimeId: 'desktop-runtime-a',
  serverId: 'linear',
} as const;

function identity(authority: McpTaskAuthorityLease, taskId = 'task-1') {
  return {
    authorityEpoch: authority.authorityEpoch,
    principalId: authority.principalId,
    resource: authority.resource,
    serverId: authority.serverId,
    taskId,
  } as const;
}

describe('McpTaskRepository', () => {
  let db: PGlite | undefined;

  /** The migrated schema, in memory unless a restart test needs a real data dir. */
  async function openMigrated(dataDir?: string): Promise<PGlite> {
    db = await createMigratedTestDb({ dataDir });
    return db;
  }

  afterEach(async () => {
    await db?.close();
  });

  it('persists a principal-bound task across a real PGlite restart', async () => {
    const dataDir = createPGliteTestDataDir('pglite-mcp-tasks');
    await openMigrated(dataDir);
    const firstRepository = new McpTaskRepository(db);
    const authority = await firstRepository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    const created = await firstRepository.create(
      {
        ...taskIdentity,
        inputMetadata: { prompt: 'choose' },
        status: 'input_required',
      },
      authority
    );
    expect(created).toMatchObject({ ...taskIdentity, status: 'input_required' });
    await db.close();

    db = await wasmLoader.createPGlite(dataDir);
    await expect(new McpTaskRepository(db).get(taskIdentity)).resolves.toEqual(created);
  });

  it('rebinds the live durable authority across restart without resurrecting a retired epoch', async () => {
    const dataDir = createPGliteTestDataDir('pglite-mcp-task-authority-restart');
    await openMigrated(dataDir);
    const firstRepository = new McpTaskRepository(db);
    const first = await firstRepository.openAuthority({
      connectionGeneration: 7,
      principalId: authorityInput.principalId,
      resource: authorityInput.resource,
      runtimeId: 'desktop-runtime-a',
      serverId: authorityInput.serverId,
    });
    await firstRepository.create({ ...first, status: 'working', taskId: 'before-restart' }, first);
    await db.close();

    db = await wasmLoader.createPGlite(dataDir);
    const restartedRepository = new McpTaskRepository(db);
    const rebound = await restartedRepository.openAuthority({
      connectionGeneration: 1,
      principalId: authorityInput.principalId,
      resource: authorityInput.resource,
      runtimeId: 'desktop-runtime-b',
      serverId: authorityInput.serverId,
    });
    expect(rebound.authorityEpoch).toBe(first.authorityEpoch);
    await expect(restartedRepository.listActive(first)).resolves.toEqual([]);
    await expect(restartedRepository.listActive(rebound)).resolves.toMatchObject([
      { authorityEpoch: first.authorityEpoch, taskId: 'before-restart' },
    ]);

    const replacement = await restartedRepository.openAuthority({
      connectionGeneration: 2,
      principalId: authorityInput.principalId,
      resource: authorityInput.resource,
      runtimeId: 'desktop-runtime-b',
      serverId: authorityInput.serverId,
    });
    expect(replacement.authorityEpoch).not.toBe(first.authorityEpoch);
    await expect(
      restartedRepository.openAuthority({
        connectionGeneration: 1,
        principalId: authorityInput.principalId,
        resource: authorityInput.resource,
        runtimeId: 'desktop-runtime-b',
        serverId: authorityInput.serverId,
      })
    ).rejects.toThrow(/acquisition is stale/u);
    await expect(restartedRepository.listActive(replacement)).resolves.toEqual([]);
    await restartedRepository.create(
      { ...replacement, status: 'working', taskId: 'after-replacement' },
      replacement
    );
    await db.close();

    db = await wasmLoader.createPGlite(dataDir);
    const secondRestartRepository = new McpTaskRepository(db);
    const secondRebound = await secondRestartRepository.openAuthority({
      connectionGeneration: 1,
      principalId: authorityInput.principalId,
      resource: authorityInput.resource,
      runtimeId: 'desktop-runtime-c',
      serverId: authorityInput.serverId,
    });
    expect(secondRebound.authorityEpoch).toBe(replacement.authorityEpoch);
    await expect(secondRestartRepository.listActive(secondRebound)).resolves.toMatchObject([
      { authorityEpoch: replacement.authorityEpoch, taskId: 'after-replacement' },
    ]);
    await expect(
      secondRestartRepository.update(
        { ...first, taskId: 'before-restart' },
        { status: 'working' },
        first
      )
    ).rejects.toThrow(/missing or stale/u);
  });

  it('updates metadata, bounds history, and makes terminal state immutable', async () => {
    await openMigrated();
    let tick = 0;
    const repository = new McpTaskRepository(
      db,
      () => new Date(Date.UTC(2026, 7, 31, 20, 0, tick++))
    );
    const authority = await repository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    await repository.create({ ...taskIdentity, status: 'working' }, authority);
    for (let index = 0; index < 35; index += 1) {
      await repository.update(
        taskIdentity,
        {
          inputMetadata: { index },
          status: index % 2 === 0 ? 'input_required' : 'working',
        },
        authority
      );
    }
    const terminal = await repository.update(
      taskIdentity,
      {
        resultMetadata: { answer: 42 },
        status: 'completed',
      },
      authority
    );
    expect(terminal.history).toHaveLength(32);
    expect(terminal.inputMetadata).toEqual({ index: 34 });
    expect(terminal.resultMetadata).toEqual({ answer: 42 });
    expect(terminal.terminalAt).toEqual(terminal.updatedAt);
    await expect(
      repository.update(taskIdentity, { status: 'cancelled' }, authority)
    ).rejects.toThrow(/immutable/u);
  });

  it('rejects stale writes and isolates server, principal, resource, and authority epoch', async () => {
    await openMigrated();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    await repository.create({ ...taskIdentity, status: 'working' }, authority);
    for (const changed of [
      { serverId: 'other' },
      { principalId: 'other' },
      { resource: 'https://example.com/mcp' },
      { authorityEpoch: '00000000-0000-7000-8000-000000000000' },
    ]) {
      await expect(repository.get({ ...taskIdentity, ...changed })).resolves.toBeNull();
    }
    const replacement = await repository.openAuthority({
      ...authorityInput,
      connectionGeneration: 8,
    });
    await expect(repository.update(taskIdentity, { status: 'working' }, authority)).rejects.toThrow(
      /missing or stale/u
    );
    await expect(
      repository.create({ ...taskIdentity, status: 'working', taskId: 'stale-task' }, authority)
    ).rejects.toThrow(/missing or stale/u);
    await expect(repository.get({ ...taskIdentity, taskId: 'stale-task' })).resolves.toBeNull();
    await expect(
      repository.create(
        { ...identity(replacement, 'replacement-task'), status: 'working' },
        replacement
      )
    ).resolves.toMatchObject({
      authorityEpoch: replacement.authorityEpoch,
      taskId: 'replacement-task',
    });
    await expect(
      repository.update(taskIdentity, { status: 'working' }, replacement)
    ).rejects.toThrow(/does not match/u);
  });

  it('enforces merged input metadata before entering input_required', async () => {
    await openMigrated();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    await repository.create({ ...taskIdentity, status: 'working' }, authority);

    await expect(
      repository.update(taskIdentity, { status: 'input_required' }, authority)
    ).rejects.toThrow(TypeError);
    await repository.update(
      taskIdentity,
      { inputMetadata: { prompt: 'choose' }, status: 'working' },
      authority
    );
    await expect(
      repository.update(taskIdentity, { status: 'input_required' }, authority)
    ).resolves.toMatchObject({
      inputMetadata: { prompt: 'choose' },
      status: 'input_required',
    });
  });

  it('enforces merged result metadata before a terminal status', async () => {
    // Review of #2913: input metadata was merged but result metadata had to
    // arrive in the same call, so a stashed result made `completed` throw.
    await openMigrated();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    await repository.create({ ...taskIdentity, status: 'working' }, authority);

    await expect(
      repository.update(taskIdentity, { status: 'completed' }, authority)
    ).rejects.toThrow(TypeError);
    await repository.update(
      taskIdentity,
      { resultMetadata: { answer: 42 }, status: 'working' },
      authority
    );
    await expect(
      repository.update(taskIdentity, { status: 'completed' }, authority)
    ).resolves.toMatchObject({ resultMetadata: { answer: 42 }, status: 'completed' });
  });

  it('rejects a bare trailing fragment marker in the resource', async () => {
    // Review of #2913: `url.hash` is '' for 'https://…/mcp#', so the guard
    // let a second row for the same endpoint through.
    await openMigrated();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    await expect(
      repository.create(
        { ...taskIdentity, resource: 'https://mcp.linear.app/mcp#', status: 'working' },
        authority
      )
    ).rejects.toThrow(/without a fragment/u);
  });

  it('bounds listActive deterministically', async () => {
    // Review of #2915: the row count of this query is the number of pollers
    // recover() fans out, so it is capped like every other bound here.
    await openMigrated();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    for (const taskId of ['a-task', 'b-task', 'c-task']) {
      await repository.create({ ...identity(authority, taskId), status: 'working' }, authority);
    }
    await expect(repository.listActive(authority, { limit: 2 })).resolves.toMatchObject([
      { taskId: 'a-task' },
      { taskId: 'b-task' },
    ]);
    await expect(repository.listActive(authority)).resolves.toHaveLength(3);
    await expect(repository.listActive(authority, { limit: 0 })).rejects.toThrow(TypeError);
  });

  it('accepts empty status messages from the protocol contract', async () => {
    await openMigrated();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    await expect(
      repository.create({ ...identity(authority), status: 'working', statusMessage: '' }, authority)
    ).resolves.toMatchObject({ statusMessage: '' });
  });

  it('rejects DB-normalized oversized metadata with a typed contract error', async () => {
    await openMigrated();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    await repository.create({ ...taskIdentity, status: 'working' }, authority);
    const metadata = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [`k${index}`, index])
    );
    expect(new TextEncoder().encode(JSON.stringify(metadata)).length).toBeLessThan(65_536);
    const failure = repository.update(
      taskIdentity,
      { inputMetadata: metadata, status: 'working' },
      authority
    );
    await expect(failure).rejects.toBeInstanceOf(McpTaskMetadataTooLargeError);
    await expect(failure).rejects.toMatchObject({
      actualBytes: expect.any(Number),
      field: 'inputMetadata',
      maxBytes: 65_536,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('lists only resumable tasks for one exact live identity scope', async () => {
    await openMigrated();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    await repository.create({ ...identity(authority, 'working'), status: 'working' }, authority);
    await repository.create(
      {
        ...identity(authority, 'input'),
        inputMetadata: { prompt: 'choose' },
        status: 'input_required',
      },
      authority
    );
    await repository.create(
      {
        ...identity(authority, 'completed'),
        resultMetadata: { answer: 42 },
        status: 'completed',
      },
      authority
    );
    const active = await repository.listActive(authority);
    expect(active).toHaveLength(2);
    expect(active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...identity(authority, 'input'), status: 'input_required' }),
        expect.objectContaining({ ...identity(authority, 'working'), status: 'working' }),
      ])
    );
    const replacement = await repository.openAuthority({
      ...authorityInput,
      connectionGeneration: 8,
    });
    await repository.create(
      {
        ...identity(replacement, 'replacement'),
        status: 'working',
      },
      replacement
    );
    const otherPrincipal = await repository.openAuthority({
      ...authorityInput,
      principalId: 'other',
    });
    await repository.create(
      {
        ...identity(otherPrincipal, 'other-principal'),
        status: 'working',
      },
      otherPrincipal
    );

    await expect(repository.listActive(replacement)).resolves.toMatchObject([
      { ...identity(replacement, 'replacement'), status: 'working' },
    ]);
  });

  it('rejects malformed inputs and corrupted persisted rows', async () => {
    await openMigrated();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    await expect(
      repository.create(
        {
          ...taskIdentity,
          resource: 'https://mcp.linear.app/./mcp',
          status: 'working',
        },
        authority
      )
    ).rejects.toThrow(/canonical/u);
    await repository.create({ ...taskIdentity, status: 'working' }, authority);
    await db.query(
      `UPDATE brainstrike_mcp_tasks
       SET history = '[{"at":"not-a-date","status":"working"}]'::jsonb`
    );
    await expect(repository.get(taskIdentity)).rejects.toThrow(/timestamp/u);
  });

  it('rejects non-monotonic or contradictory durable history during hydration', async () => {
    await openMigrated();
    const repository = new McpTaskRepository(db);
    const authority = await repository.openAuthority(authorityInput);
    const corruptions = [
      {
        history: [
          { at: '2026-09-01T05:00:00.000Z', status: 'working' },
          { at: '2026-09-01T04:59:59.000Z', status: 'working' },
        ],
        message: /monotonic/u,
        taskId: 'non-monotonic',
        updatedAt: '2026-09-01T05:00:02.000Z',
      },
      {
        history: [
          { at: '2026-09-01T05:00:00.000Z', status: 'working' },
          { at: '2026-09-01T05:00:01.000Z', status: 'cancelled' },
        ],
        message: /final status/u,
        taskId: 'status-mismatch',
        updatedAt: '2026-09-01T05:00:01.000Z',
      },
      {
        history: [
          { at: '2026-09-01T05:00:00.000Z', status: 'working' },
          { at: '2026-09-01T05:00:00.500Z', status: 'working' },
        ],
        message: /end at updatedAt/u,
        taskId: 'updated-at-mismatch',
        updatedAt: '2026-09-01T05:00:01.000Z',
      },
      {
        history: [
          { at: '2026-09-01T05:00:00.000Z', status: 'completed' },
          { at: '2026-09-01T05:00:01.000Z', status: 'working' },
        ],
        message: /cannot continue after a terminal status/u,
        taskId: 'terminal-regression',
        updatedAt: '2026-09-01T05:00:01.000Z',
      },
    ] as const;

    for (const corruption of corruptions) {
      const taskIdentity = identity(authority, corruption.taskId);
      await repository.create({ ...taskIdentity, status: 'working' }, authority);
      await db.query(
        `UPDATE brainstrike_mcp_tasks
         SET created_at = '2026-09-01T05:00:00.000Z'::timestamptz,
             updated_at = $1::timestamptz,
             history = $2::jsonb
         WHERE authority_epoch = $3::uuid AND task_id = $4`,
        [
          corruption.updatedAt,
          JSON.stringify(corruption.history),
          authority.authorityEpoch,
          corruption.taskId,
        ]
      );
      await expect(repository.get(taskIdentity)).rejects.toThrow(corruption.message);
    }
  });
});
