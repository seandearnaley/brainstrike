import { createDelegatedConversationRepository } from '@brainstrike/db';
import { isAgentColor } from '@brainstrike/types/agent-color';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDesktopDelegatedConversationHost } from '../../assistant-server/delegated-conversation-host';
import { refreshDelegatedFamilyColors } from '../../assistant-server/refresh-delegated-family-colors';
import { BUDGETED_HOST_SETTINGS, createBudgetedHost } from './fixtures/budgeted-host';
import { createHostDatabase, identity, scope } from './fixtures/delegated-host-fixtures';

describe('durable delegated family colors', () => {
  let database: PGlite;
  beforeEach(async () => {
    database = await createHostDatabase(`memory://delegated-family-${crypto.randomUUID()}`);
  }, 30_000);
  afterEach(async () => {
    await database.close();
  });

  it('persists distinct continuous sibling accents and recursive descendants', async () => {
    await database.query('UPDATE mastra_threads SET metadata = $1::jsonb WHERE id = $2', [
      JSON.stringify({ color: 'rose' }),
      'root',
    ]);
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.persist({
      ...identity,
      childResourceId: 'native-sibling-owner',
      childThreadId: 'sibling',
      parentToolCallId: 'sibling-call',
    });
    await database.query(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt")
      VALUES ('grandchild', 'native-grandchild-owner', 'Grandchild', '{}', NOW(), NOW())`);
    await host.persist({
      ...identity,
      childResourceId: 'native-grandchild-owner',
      childThreadId: 'grandchild',
      parentResourceId: identity.childResourceId,
      parentRuntimeRunId: 'child-run',
      parentThreadId: identity.childThreadId,
      parentToolCallId: 'grandchild-call',
    });
    const repository = createDelegatedConversationRepository(database);
    const colors = await Promise.all(
      ['child', 'sibling', 'grandchild'].map(async (id) => (await repository.get(scope, id))?.color)
    );
    expect(colors.every((color) => isAgentColor(color) && color.startsWith('family:'))).toBe(true);
    expect(new Set(colors).size).toBe(3);
    expect(colors).not.toContain('rose');
  });

  it('reuses an existing child identity even if the root color later changes', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    const repository = createDelegatedConversationRepository(database);
    const before = await repository.get(scope, 'child');
    await database.query('UPDATE mastra_threads SET metadata = $1::jsonb WHERE id = $2', [
      JSON.stringify({ color: 'rose' }),
      'root',
    ]);
    await host.persist(identity);
    expect(await repository.get(scope, 'child')).toMatchObject({
      color: before?.color,
      displayName: before?.displayName,
    });
  });

  it('allocates distinct accents for concurrent sibling admissions', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await Promise.all([
      host.persist(identity),
      host.persist({
        ...identity,
        childResourceId: 'native-sibling-owner',
        childThreadId: 'sibling',
        parentToolCallId: 'sibling-call',
      }),
    ]);
    const repository = createDelegatedConversationRepository(database);
    const first = (await repository.get(scope, 'child'))?.color;
    const second = (await repository.get(scope, 'sibling'))?.color;
    expect(first).toMatch(/^family:/u);
    expect(second).toMatch(/^family:/u);
    expect(first).not.toBe(second);
  });

  it('rejects invalid root color before admitting a new child', async () => {
    await database.query('UPDATE mastra_threads SET metadata = $1::jsonb WHERE id = $2', [
      JSON.stringify({ color: 'not-a-color' }),
      'root',
    ]);
    await expect(createBudgetedHost(database, 'initial-leg').persist(identity)).rejects.toThrow();
    expect(await createDelegatedConversationRepository(database).get(scope, 'child')).toBeNull();
  });

  it('keeps a broad recursive tree globally unique beyond eighteen children', async () => {
    const host = createDesktopDelegatedConversationHost(
      database,
      'initial-leg',
      undefined,
      undefined,
      { ...BUDGETED_HOST_SETTINGS, maxInvocations: 32 }
    );
    const colors: string[] = [];
    const repository = createDelegatedConversationRepository(database);
    for (let index = 0; index < 22; index += 1) {
      const childThreadId = `wide-${index}`;
      const childResourceId = `wide-owner-${index}`;
      await database.query(
        `INSERT INTO mastra_threads
        (id, "resourceId", title, metadata, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, '{}', NOW(), NOW())`,
        [childThreadId, childResourceId, childThreadId]
      );
      await host.persist({
        ...identity,
        childResourceId,
        childThreadId,
        parentToolCallId: `wide-call-${index}`,
      });
      const child = await repository.get(scope, childThreadId);
      if (!child?.color) {
        throw new Error('Missing child color.');
      }
      colors.push(child.color);
    }
    for (const index of [0, 1]) {
      const childThreadId = `deep-${index}`;
      const childResourceId = `deep-owner-${index}`;
      await database.query(
        `INSERT INTO mastra_threads
        (id, "resourceId", title, metadata, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, '{}', NOW(), NOW())`,
        [childThreadId, childResourceId, childThreadId]
      );
      await host.persist({
        ...identity,
        childResourceId,
        childThreadId,
        parentResourceId: `wide-owner-${index}`,
        parentRuntimeRunId: `wide-run-${index}`,
        parentThreadId: `wide-${index}`,
        parentToolCallId: `deep-call-${index}`,
      });
      const child = await repository.get(scope, childThreadId);
      if (!child?.color) {
        throw new Error('Missing descendant color.');
      }
      colors.push(child.color);
    }
    expect(colors).toHaveLength(24);
    expect(new Set(colors).size).toBe(24);
  });

  it('refreshes legacy duplicates through the saved tree without changing identities or runs', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.persist({
      ...identity,
      childResourceId: 'native-sibling-owner',
      childThreadId: 'sibling',
      parentToolCallId: 'sibling-call',
    });
    await database.query(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt")
      VALUES ('grandchild', 'native-grandchild-owner', 'Grandchild', '{}', NOW(), NOW())`);
    await host.persist({
      ...identity,
      childResourceId: 'native-grandchild-owner',
      childThreadId: 'grandchild',
      parentResourceId: identity.childResourceId,
      parentRuntimeRunId: 'child-run',
      parentThreadId: identity.childThreadId,
      parentToolCallId: 'grandchild-call',
    });
    await database.query(
      `UPDATE brainstrike_delegated_conversations SET color = 'rose'
       WHERE thread_id IN ('child', 'sibling', 'grandchild')`
    );
    await database.query(
      `UPDATE brainstrike_assistant_thread_runs SET status = 'completed'
       WHERE thread_id = 'root'`
    );
    const repository = createDelegatedConversationRepository(database);
    const before = await repository.listDescendants(scope);
    expect(await refreshDelegatedFamilyColors(database, scope)).toBe(3);
    const after = await repository.listDescendants(scope);
    expect(new Set(after.map((node) => node.color)).size).toBe(3);
    expect(after.map(({ color: _color, ...rest }) => rest)).toEqual(
      before.map(({ color: _color, ...rest }) => rest)
    );
    expect(await refreshDelegatedFamilyColors(database, scope)).toBe(0);
    const otherRun = await database.query(
      `SELECT status FROM brainstrike_assistant_thread_runs WHERE id = 'other-root-leg'`
    );
    expect(otherRun.rows).toEqual([{ status: 'running' }]);
  });

  it('refuses active roots and cross-owner refresh requests without changing colors', async () => {
    await createBudgetedHost(database, 'initial-leg').persist(identity);
    const repository = createDelegatedConversationRepository(database);
    const before = (await repository.get(scope, 'child'))?.color;
    await expect(refreshDelegatedFamilyColors(database, scope)).rejects.toMatchObject({
      reason: 'agent-colors-active-run',
    });
    await expect(
      refreshDelegatedFamilyColors(database, { ...scope, ownerResourceId: 'foreign' })
    ).rejects.toMatchObject({ reason: 'root-scope-mismatch' });
    expect((await repository.get(scope, 'child'))?.color).toBe(before);
  });

  it('does not recolor while a concurrent delegation is admitted', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    const [refresh, admission] = await Promise.allSettled([
      refreshDelegatedFamilyColors(database, scope),
      host.persist(identity),
    ]);
    expect(refresh.status).toBe('rejected');
    if (refresh.status === 'rejected') {
      expect(refresh.reason).toMatchObject({ reason: 'agent-colors-active-run' });
    }
    expect(admission.status).toBe('fulfilled');
    expect(
      (await createDelegatedConversationRepository(database).get(scope, 'child'))?.color
    ).toMatch(/^family:/u);
  });
});
