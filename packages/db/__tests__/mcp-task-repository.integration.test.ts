import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { McpTaskRepository } from '../src/repositories/mcp-task-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const identity = {
  generation: 7,
  principalId: 'linear:user-42',
  resource: 'https://mcp.linear.app/mcp',
  serverId: 'linear',
  taskId: 'task-1',
} as const;
const currentGeneration = { currentGeneration: identity.generation } as const;

describe('McpTaskRepository', () => {
  let db: PGlite | undefined;

  async function openNumbered(dataDir = 'memory://'): Promise<PGlite> {
    db = await wasmLoader.createPGlite(dataDir);
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    return db;
  }

  afterEach(async () => {
    await db?.close();
  });

  it('persists a principal-bound task across a real PGlite restart', async () => {
    const dataDir = createPGliteTestDataDir('pglite-mcp-tasks');
    await openNumbered(dataDir);

    const created = await new McpTaskRepository(db).create(
      {
        ...identity,
        inputMetadata: { prompt: 'choose' },
        status: 'input_required',
      },
      currentGeneration
    );
    expect(created).toMatchObject({ ...identity, status: 'input_required' });
    await db.close();

    db = await wasmLoader.createPGlite(dataDir);
    await expect(new McpTaskRepository(db).get(identity)).resolves.toEqual(created);
  });

  it('is discovered by the production Drizzle migration ledger', async () => {
    db = await wasmLoader.createPGlite('memory://');
    await expect(runMigrations(db)).resolves.toMatchObject({ success: true });
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'brainstrike_mcp_tasks'"
    );
    expect(tables.rows).toEqual([{ table_name: 'brainstrike_mcp_tasks' }]);
  });

  it('updates metadata, bounds history, and makes terminal state immutable', async () => {
    await openNumbered();
    let tick = 0;
    const repository = new McpTaskRepository(
      db,
      () => new Date(Date.UTC(2026, 7, 31, 20, 0, tick++))
    );
    await repository.create({ ...identity, status: 'working' }, currentGeneration);
    for (let index = 0; index < 35; index += 1) {
      await repository.update(
        identity,
        {
          inputMetadata: { index },
          status: index % 2 === 0 ? 'input_required' : 'working',
        },
        currentGeneration
      );
    }
    const terminal = await repository.update(
      identity,
      {
        resultMetadata: { answer: 42 },
        status: 'completed',
      },
      currentGeneration
    );
    expect(terminal.history).toHaveLength(32);
    expect(terminal.inputMetadata).toEqual({ index: 34 });
    expect(terminal.resultMetadata).toEqual({ answer: 42 });
    expect(terminal.terminalAt).toEqual(terminal.updatedAt);
    await expect(
      repository.update(identity, { status: 'cancelled' }, currentGeneration)
    ).rejects.toThrow(/immutable/u);
  });

  it('rejects stale writes and isolates server, principal, resource, and generation', async () => {
    await openNumbered();
    const repository = new McpTaskRepository(db);
    await repository.create({ ...identity, status: 'working' }, currentGeneration);
    for (const changed of [
      { serverId: 'other' },
      { principalId: 'other' },
      { resource: 'https://example.com/mcp' },
      { generation: 8 },
    ]) {
      await expect(repository.get({ ...identity, ...changed })).resolves.toBeNull();
    }
    await expect(
      repository.update(identity, { status: 'working' }, { currentGeneration: 8 })
    ).rejects.toThrow(/missing or stale/u);
    await expect(
      repository.create(
        { ...identity, generation: 6, status: 'working', taskId: 'stale-task' },
        { currentGeneration: 8 }
      )
    ).rejects.toThrow(/missing or stale/u);
    await expect(
      repository.get({ ...identity, generation: 6, taskId: 'stale-task' })
    ).resolves.toBeNull();
    await expect(
      repository.create(
        { ...identity, generation: 8, status: 'working', taskId: 'replacement-task' },
        { currentGeneration: 8 }
      )
    ).resolves.toMatchObject({ generation: 8, taskId: 'replacement-task' });
    await expect(
      repository.update(
        { ...identity, generation: 6 },
        { status: 'working' },
        { currentGeneration: 8 }
      )
    ).rejects.toThrow(/missing or stale/u);
  });

  it('enforces merged input metadata before entering input_required', async () => {
    await openNumbered();
    const repository = new McpTaskRepository(db);
    await repository.create({ ...identity, status: 'working' }, currentGeneration);

    await expect(
      repository.update(identity, { status: 'input_required' }, currentGeneration)
    ).rejects.toThrow(TypeError);
    await repository.update(
      identity,
      { inputMetadata: { prompt: 'choose' }, status: 'working' },
      currentGeneration
    );
    await expect(
      repository.update(identity, { status: 'input_required' }, currentGeneration)
    ).resolves.toMatchObject({
      inputMetadata: { prompt: 'choose' },
      status: 'input_required',
    });
  });

  it('enforces merged result metadata before a terminal status', async () => {
    // Review of #2913: input metadata was merged but result metadata had to
    // arrive in the same call, so a stashed result made `completed` throw.
    await openNumbered();
    const repository = new McpTaskRepository(db);
    await repository.create({ ...identity, status: 'working' }, currentGeneration);

    await expect(
      repository.update(identity, { status: 'completed' }, currentGeneration)
    ).rejects.toThrow(TypeError);
    await repository.update(
      identity,
      { resultMetadata: { answer: 42 }, status: 'working' },
      currentGeneration
    );
    await expect(
      repository.update(identity, { status: 'completed' }, currentGeneration)
    ).resolves.toMatchObject({ resultMetadata: { answer: 42 }, status: 'completed' });
  });

  it('rejects a bare trailing fragment marker in the resource', async () => {
    // Review of #2913: `url.hash` is '' for 'https://…/mcp#', so the guard
    // let a second row for the same endpoint through.
    await openNumbered();
    const repository = new McpTaskRepository(db);
    await expect(
      repository.create(
        { ...identity, resource: 'https://mcp.linear.app/mcp#', status: 'working' },
        currentGeneration
      )
    ).rejects.toThrow(/without a fragment/u);
  });

  it('bounds listActive deterministically', async () => {
    // Review of #2915: the row count of this query is the number of pollers
    // recover() fans out, so it is capped like every other bound here.
    await openNumbered();
    const repository = new McpTaskRepository(db);
    for (const taskId of ['a-task', 'b-task', 'c-task']) {
      await repository.create({ ...identity, status: 'working', taskId }, currentGeneration);
    }
    const scope = {
      generation: identity.generation,
      principalId: identity.principalId,
      resource: identity.resource,
      serverId: identity.serverId,
    };
    await expect(repository.listActive(scope, { limit: 2 })).resolves.toMatchObject([
      { taskId: 'a-task' },
      { taskId: 'b-task' },
    ]);
    await expect(repository.listActive(scope)).resolves.toHaveLength(3);
    await expect(repository.listActive(scope, { limit: 0 })).rejects.toThrow(TypeError);
  });

  it('accepts empty status messages from the protocol contract', async () => {
    await openNumbered();
    const repository = new McpTaskRepository(db);
    await expect(
      repository.create({ ...identity, status: 'working', statusMessage: '' }, currentGeneration)
    ).resolves.toMatchObject({ statusMessage: '' });
  });

  it('rejects DB-normalized oversized metadata with a typed contract error', async () => {
    await openNumbered();
    const repository = new McpTaskRepository(db);
    await repository.create({ ...identity, status: 'working' }, currentGeneration);
    const metadata = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [`k${index}`, index])
    );
    expect(new TextEncoder().encode(JSON.stringify(metadata)).length).toBeLessThan(65_536);
    await expect(
      repository.update(identity, { inputMetadata: metadata, status: 'working' }, currentGeneration)
    ).rejects.toThrow(TypeError);
  });

  it('rejects malformed inputs and corrupted persisted rows', async () => {
    await openNumbered();
    const repository = new McpTaskRepository(db);
    await expect(
      repository.create(
        {
          ...identity,
          resource: 'https://mcp.linear.app/./mcp',
          status: 'working',
        },
        currentGeneration
      )
    ).rejects.toThrow(/canonical/u);
    await repository.create({ ...identity, status: 'working' }, currentGeneration);
    await db.query(
      `UPDATE brainstrike_mcp_tasks
       SET history = '[{"at":"not-a-date","status":"working"}]'::jsonb`
    );
    await expect(repository.get(identity)).rejects.toThrow(/timestamp/u);
  });
});
