import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { migration128DelegatedInvocationUsage } from '../src/migrations/128-delegated-invocation-usage';
import { migration135DelegatedContinuations } from '../src/migrations/135-delegated-continuations';
import { createEnginePglite } from '../src/pglite-factory.js';
import {
  createDelegatedConversationRepository,
  DelegatedConversationIdentityError,
} from '../src/repositories/delegated-conversation-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('durable delegated conversation graph (BST-1718)', () => {
  let database: PGlite;
  const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
  const child = {
    color: 'blue',
    configuration: { instructions: 'Inspect files', maxSteps: 16, personaId: 'explore' },
    displayName: 'Cedar',
    parentThreadId: 'root',
    resourceId: 'native-child-resource',
    threadId: 'child',
  } as const;

  beforeEach(async () => {
    database = await createMigratedTestDb();
    await database.query(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt") VALUES
      ('root', 'owner', 'Root', '{"operatingRootId":"workspace-root"}', NOW(), NOW()),
      ('other-root', 'owner', 'Other root', '{}', NOW(), NOW()),
      ('foreign-root', 'other-owner', 'Foreign root', '{}', NOW(), NOW()),
      ('child', 'native-child-resource', 'Child', '{}', NOW(), NOW()),
      ('sibling', 'native-child-resource', 'Sibling', '{}', NOW(), NOW()),
      ('grandchild', 'native-leaf-resource', 'Grandchild', '{}', NOW(), NOW())`);
  });

  afterEach(async () => {
    await database.close();
  });

  it.each(['', '   ', 42, { path: 'invalid' }])(
    'rejects malformed workspace metadata %j without binding a child',
    async (workspace) => {
      const repository = createDelegatedConversationRepository(database);
      await repository.registerRoot(scope);
      await database.query('UPDATE mastra_threads SET metadata = $1::jsonb WHERE id = $2', [
        JSON.stringify({ operatingRootId: workspace }),
        'root',
      ]);
      await expect(repository.createChild(scope, child)).rejects.toBeInstanceOf(
        DelegatedConversationIdentityError
      );
      expect(await repository.listChildren(scope, 'root')).toEqual([]);
    }
  );

  it('rejects an out-of-palette color from an untyped caller', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.registerRoot(scope);
    await expect(
      repository.createChild(scope, {
        ...child,
        // @ts-expect-error Exercise a value arriving outside the typed host API.
        color: 'red',
      })
    ).rejects.toBeInstanceOf(DelegatedConversationIdentityError);
    expect(await repository.listChildren(scope, 'root')).toEqual([]);
  });

  it('reloads the exact child identity, ancestry, configuration and workspace binding', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.registerRoot(scope);
    const saved = await repository.createChild(scope, child);
    expect(saved).toMatchObject({
      ...child,
      ownerResourceId: 'owner',
      rootThreadId: 'root',
      workspaceRootId: 'workspace-root',
    });
    const recreated = createDelegatedConversationRepository(database);
    expect(await recreated.get(scope, 'child')).toEqual(saved);
    expect(await recreated.listChildren(scope, 'root')).toEqual([saved]);
  });

  it('idempotently binds duplicate delivery while keeping same-persona siblings distinct', async () => {
    const first = createDelegatedConversationRepository(database);
    const second = createDelegatedConversationRepository(database);
    await Promise.all([first.registerRoot(scope), second.registerRoot(scope)]);
    const results = await Promise.all([
      first.createChild(scope, child),
      second.createChild(scope, child),
      second.createChild(scope, { ...child, displayName: 'Flint', threadId: 'sibling' }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((await first.listChildren(scope, 'root')).map((node) => node.threadId).sort()).toEqual([
      'child',
      'sibling',
    ]);
  });

  it('rejects cross-owner, cross-root, forged-scope and changed-configuration writes', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.registerRoot(scope);
    await repository.registerRoot({ ...scope, rootThreadId: 'other-root' });
    await repository.createChild(scope, child);
    await expect(
      repository.registerRoot({ ...scope, rootThreadId: 'foreign-root' })
    ).rejects.toBeInstanceOf(DelegatedConversationIdentityError);
    await expect(
      repository.get({ ...scope, ownerResourceId: 'other-owner' }, 'child')
    ).rejects.toBeInstanceOf(DelegatedConversationIdentityError);
    await expect(
      repository.listChildren({ ...scope, ownerResourceId: 'other-owner' }, 'root')
    ).rejects.toBeInstanceOf(DelegatedConversationIdentityError);
    await expect(
      repository.createChild(
        { ...scope, rootThreadId: 'other-root' },
        { ...child, parentThreadId: 'other-root' }
      )
    ).rejects.toBeInstanceOf(DelegatedConversationIdentityError);
    await expect(
      repository.createChild(scope, { ...child, resourceId: 'forged' })
    ).rejects.toBeInstanceOf(DelegatedConversationIdentityError);
    await expect(
      repository.createChild(scope, {
        ...child,
        configuration: { ...child.configuration, maxSteps: 100 },
      })
    ).rejects.toBeInstanceOf(DelegatedConversationIdentityError);
    expect(await repository.get({ ...scope, rootThreadId: 'other-root' }, 'child')).toBeNull();
    expect(await repository.get(scope, 'child')).toMatchObject(child);
  });

  it('captures the workspace at birth and preserves an existing branch binding', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.registerRoot(scope);
    await repository.createChild(scope, child);
    await database.query(
      `UPDATE mastra_threads SET metadata = '{"operatingRootId":"changed-workspace"}' WHERE id = 'root'`
    );
    await repository.registerRoot(scope);
    const leaf = await repository.createChild(scope, {
      ...child,
      displayName: 'Wren',
      parentThreadId: 'child',
      resourceId: 'native-leaf-resource',
      threadId: 'grandchild',
    });
    expect(leaf.workspaceRootId).toBe('workspace-root');
    expect(await repository.listChildren(scope, 'child')).toEqual([leaf]);
    expect((await repository.listChildren(scope, 'root')).map((node) => node.threadId)).toEqual([
      'child',
    ]);
    const sibling = await repository.createChild(scope, { ...child, threadId: 'sibling' });
    expect(sibling.workspaceRootId).toBe('changed-workspace');
    expect((await repository.createChild(scope, child)).workspaceRootId).toBe('workspace-root');
  });

  it('does not expose or extend a descendant through an ancestor whose native scope changed', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.registerRoot(scope);
    await repository.createChild(scope, child);
    const leaf = {
      ...child,
      displayName: 'Wren',
      parentThreadId: 'child',
      resourceId: 'native-leaf-resource',
      threadId: 'grandchild',
    };
    await repository.createChild(scope, leaf);
    await database.query(
      `UPDATE mastra_threads SET "resourceId" = 'different-owner' WHERE id = 'child'`
    );
    expect(await repository.get(scope, 'grandchild')).toBeNull();
    expect(await repository.listChildren(scope, 'child')).toEqual([]);
    await expect(
      repository.createChild(scope, { ...child, parentThreadId: 'grandchild', threadId: 'sibling' })
    ).rejects.toBeInstanceOf(DelegatedConversationIdentityError);
  });

  it('reports missing legacy identities without fabricating nodes', async () => {
    const repository = createDelegatedConversationRepository(database);
    expect(await repository.get(scope, 'child')).toBeNull();
    expect(await repository.listChildren(scope, 'root')).toEqual([]);
    const rows = await database.query('SELECT * FROM brainstrike_delegated_conversations');
    expect(rows.rows).toEqual([]);
  });

  it('cascades graph branches when native parent threads are deleted', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.registerRoot(scope);
    await repository.createChild(scope, child);
    await repository.createChild(scope, {
      ...child,
      parentThreadId: 'child',
      resourceId: 'native-leaf-resource',
      threadId: 'grandchild',
    });
    await repository.createChild(scope, { ...child, threadId: 'sibling' });
    await database.query("DELETE FROM mastra_threads WHERE id = 'child'");
    expect(await repository.get(scope, 'grandchild')).toBeNull();
    expect((await repository.listChildren(scope, 'root')).map((node) => node.threadId)).toEqual([
      'sibling',
    ]);
    await database.query("DELETE FROM mastra_threads WHERE id = 'root'");
    expect(
      (await database.query('SELECT * FROM brainstrike_delegated_conversations')).rows
    ).toEqual([]);
  });

  it('rejects non-JSON configuration rather than silently changing the snapshot', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.registerRoot(scope);
    await expect(
      repository.createChild(scope, { ...child, configuration: { budget: Number.NaN } })
    ).rejects.toThrow('serializable JSON object');
    expect(await repository.listChildren(scope, 'root')).toEqual([]);
  });

  it('restores the same identities from a serialized database in a new engine', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.registerRoot(scope);
    const saved = await repository.createChild(scope, child);
    const snapshot = await database.dumpDataDir('none');
    await database.close();
    database = await createEnginePglite({ loadDataDir: snapshot });
    expect(await createDelegatedConversationRepository(database).get(scope, 'child')).toEqual(
      saved
    );
  });

  it('rejects snapshot values that JSON would omit or evaluate', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.registerRoot(scope);
    let getterCalls = 0;
    const getter = Object.defineProperty({}, 'dynamic', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'evaluated';
      },
    });
    for (const configuration of [
      { sparse: new Array<number>(2) },
      Object.defineProperty({}, 'hidden', { value: 'lost' }),
      { [Symbol('lost')]: 'lost' },
      getter,
    ]) {
      await expect(repository.createChild(scope, { ...child, configuration })).rejects.toThrow(
        'serializable JSON object'
      );
    }
    expect(getterCalls).toBe(0);
    expect(await repository.listChildren(scope, 'root')).toEqual([]);
  });

  it('upgrades a legacy database through the production ledger and replays without changes', async () => {
    // Only this isolated test database is rewound to its pre-126 shape.
    if (typeof migration128DelegatedInvocationUsage.down !== 'string') {
      throw new Error('Expected SQL migration');
    }
    if (typeof migration135DelegatedContinuations.down !== 'string') {
      throw new Error('Expected SQL migration');
    }
    await database.exec(migration135DelegatedContinuations.down);
    await database.exec(migration128DelegatedInvocationUsage.down);
    await database.exec(
      'DROP TABLE brainstrike_delegated_tool_decisions; DROP TABLE brainstrike_delegated_invocations; DROP TABLE brainstrike_delegated_conversations'
    );
    await database.query(
      "DELETE FROM __drizzle_migrations WHERE hash IN ('custom-126-delegated-conversations', 'custom-127-delegated-invocations', 'custom-128-delegated-invocation-usage', 'custom-131-delegated-tool-decisions', 'custom-135-delegated-continuations')"
    );
    const nativeBefore = await database.query('SELECT * FROM mastra_threads ORDER BY id');
    const first = await runMigrations(database);
    expect(first.success).toBe(true);
    // The ledger and physical schema must agree after replay, including the
    // decision sidecar and the invocation column added by migration 131.
    expect(
      (await database.query('SELECT * FROM brainstrike_delegated_tool_decisions')).rows
    ).toEqual([]);
    expect(
      (await database.query('SELECT original_tool_call FROM brainstrike_delegated_invocations'))
        .rows
    ).toEqual([]);
    expect(first.appliedMigrations).toHaveLength(5);
    const repository = createDelegatedConversationRepository(database);
    expect(await repository.get(scope, 'child')).toBeNull();
    expect((await database.query('SELECT * FROM mastra_threads ORDER BY id')).rows).toEqual(
      nativeBefore.rows
    );
    await repository.registerRoot(scope);
    const saved = await repository.createChild(scope, child);
    expect(await runMigrations(database)).toEqual({ appliedMigrations: [], success: true });
    expect(await repository.get(scope, 'child')).toEqual(saved);
    expect(
      (
        await database.query(
          "SELECT hash FROM __drizzle_migrations WHERE hash = 'custom-126-delegated-conversations'"
        )
      ).rows
    ).toHaveLength(1);
  });
});
