import type {
  DelegatedConversationIdentity,
  DelegatedRunIdentity,
  StreamChunk,
} from '@brainstrike/agent';
import { createDelegatedConversationRepository, migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopDelegatedConversationHost } from '../../assistant-server/delegated-conversation-host';
import { desktopAssistantServerLogger as logger } from '../../assistant-server/logger';
import { persistDesktopChildRunUsage } from '../../assistant-server/run-persistence';

describe('desktop delegated conversation authority', () => {
  let database: PGlite;
  const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
  const identity: DelegatedConversationIdentity = {
    childResourceId: 'native-child-owner',
    childThreadId: 'child',
    configuration: { maxSteps: 16, persona: { id: 'explore' } },
    parentResourceId: 'owner',
    parentRuntimeRunId: 'parent-native-run',
    parentThreadId: 'root',
    parentToolCallId: 'parent-call',
    personaId: 'explore',
  };
  const run: DelegatedRunIdentity = {
    childRuntimeRunId: 'child-native-run',
    parentRuntimeRunId: identity.parentRuntimeRunId,
    parentToolCallId: identity.parentToolCallId,
    personaId: identity.personaId,
  };

  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://delegated-host');
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt") VALUES
      ('root', 'owner', 'Root', '{}', NOW(), NOW()),
      ('other', 'owner', 'Other root', '{}', NOW(), NOW()),
      ('child', 'native-child-owner', 'Child', '{}', NOW(), NOW()),
      ('sibling', 'native-sibling-owner', 'Sibling', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id) VALUES
      ('initial-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn'),
      ('resume-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn'),
      ('other-turn-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'other-turn'),
      ('other-root-leg', 'owner', 'other', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn');`);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  async function persistUsage(
    value: Extract<StreamChunk, { type: 'child-run-usage' }>['value'],
    hostRunId = 'initial-leg'
  ): Promise<void> {
    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'child-run-usage', value };
    }
    for await (const chunk of persistDesktopChildRunUsage(
      source(),
      hostRunId,
      undefined,
      async () => database,
      true
    )) {
      expect(chunk.type).toBe('child-run-usage');
    }
  }

  const usage = {
    delegation: {
      parentRuntimeRunId: identity.parentRuntimeRunId,
      parentToolCallId: identity.parentToolCallId,
      resourceId: identity.childResourceId,
      threadId: identity.childThreadId,
    },
    estimated: false,
    inputTokens: 5,
    outputTokens: 3,
    personaId: 'explore',
    source: 'subagent',
  } as const;

  it('uses the existing usage writer for one cumulative row across host resume legs', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    await persistUsage(usage);
    await persistUsage(usage);
    await persistUsage({ ...usage, inputTokens: 10, outputTokens: 6 }, 'resume-leg');
    expect(
      (
        await database.query(`SELECT run_id, input_tokens, output_tokens, delegation_tool_call_id
      FROM brainstrike_assistant_run_usage`)
      ).rows
    ).toEqual([
      {
        delegation_tool_call_id: 'parent-call',
        input_tokens: 10,
        output_tokens: 6,
        run_id: 'initial-leg',
      },
    ]);
  });

  it('rejects missing or unauthorized bound usage before publishing a refresh chunk', async () => {
    const { delegation: _delegation, ...withoutIdentity } = usage;
    await expect(persistUsage(withoutIdentity)).rejects.toThrow();
    await expect(persistUsage(usage)).rejects.toThrow();
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(identity);
    await expect(persistUsage(usage)).rejects.toThrow();
    await host.bindRun(run);
    await expect(persistUsage(usage, 'other-turn-leg')).rejects.toThrow();
    await expect(persistUsage({ ...usage, personaId: 'wrong' })).rejects.toThrow();
    expect((await database.query('SELECT id FROM brainstrike_assistant_run_usage')).rows).toEqual(
      []
    );
  });

  it('logs and propagates a storage failure without publishing a usage refresh', async () => {
    const error = new Error('Database unavailable');
    const diagnostic = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'child-run-usage', value: usage };
    }
    const iterator = persistDesktopChildRunUsage(
      source(),
      'initial-leg',
      undefined,
      () => Promise.reject(error),
      true
    )[Symbol.asyncIterator]();
    try {
      await expect(iterator.next()).rejects.toBe(error);
      expect(diagnostic).toHaveBeenCalledWith(
        'Failed to persist bound delegated usage',
        expect.objectContaining({
          code: 'assistant_delegated_usage_write_failed',
          error,
          runId: 'initial-leg',
        })
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('persists native child identity and a stable display before binding its run', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(identity);
    const repository = createDelegatedConversationRepository(database);
    const child = await repository.get(scope, 'child');
    expect(child).toMatchObject({
      ...scope,
      parentThreadId: 'root',
      resourceId: 'native-child-owner',
    });
    expect(child?.displayName).toMatch(/^[A-Z][a-z]+-[0-9a-f]{6}$/u);
    expect(await repository.getInvocation(scope, run)).toMatchObject({
      childRuntimeRunId: null,
      hostRunId: 'initial-leg',
      turnMessageId: 'user-turn',
    });
    await host.bindRun(run);
    await host.persist(identity);
    expect(await repository.get(scope, 'child')).toEqual(child);
    expect(await repository.getInvocation(scope, run)).toMatchObject({
      childRuntimeRunId: 'child-native-run',
    });
  });

  it('reauthorizes the original invocation across reconstructed host resume legs', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    await createDesktopDelegatedConversationHost(database, 'resume-leg').bindRun(run);
    expect(
      await createDelegatedConversationRepository(database).getInvocation(scope, run)
    ).toMatchObject({ childRuntimeRunId: 'child-native-run', hostRunId: 'initial-leg' });
  });

  it.each(['other-turn-leg', 'other-root-leg', 'missing-leg'])(
    'rejects resumed publication through an unauthorized host leg (%s)',
    async (runId) => {
      await createDesktopDelegatedConversationHost(database, 'initial-leg').persist(identity);
      await expect(
        createDesktopDelegatedConversationHost(database, runId).bindRun(run)
      ).rejects.toThrow();
      expect(
        await createDelegatedConversationRepository(database).getInvocation(scope, run)
      ).toMatchObject({ childRuntimeRunId: null });
    }
  );

  it('rechecks the current host turn atomically when it changes after scope lookup', async () => {
    const initial = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await initial.persist(identity);
    const raced = createDesktopDelegatedConversationHost(
      {
        query: async (sql, params) => {
          const result = await database.query(sql, params);
          if (sql.includes('WHERE runs.id = $1')) {
            await database.exec(
              "UPDATE brainstrike_assistant_thread_runs SET turn_message_id = 'changed' WHERE id = 'resume-leg'"
            );
          }
          return result;
        },
      },
      'resume-leg'
    );
    await expect(raced.bindRun(run)).rejects.toThrow();
    expect(
      await createDelegatedConversationRepository(database).getInvocation(scope, run)
    ).toMatchObject({ childRuntimeRunId: null });
  });

  it('rejects a forged parent native resource before registering its child', async () => {
    await expect(
      createDesktopDelegatedConversationHost(database, 'initial-leg').persist({
        ...identity,
        parentResourceId: 'forged',
      })
    ).rejects.toThrow();
    expect((await database.query('SELECT * FROM brainstrike_delegated_invocations')).rows).toEqual(
      []
    );
  });

  it('rejects an observed persona mismatch and changed native scope', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(identity);
    await expect(host.bindRun({ ...run, personaId: 'analyze' })).rejects.toThrow();
    await database.query(`UPDATE mastra_threads SET "resourceId" = 'changed' WHERE id = 'child'`);
    await expect(host.bindRun(run)).rejects.toThrow();
  });

  it('persists concurrent instances of the same persona independently', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await Promise.all([
      host.persist(identity),
      host.persist({
        ...identity,
        childResourceId: 'native-sibling-owner',
        childThreadId: 'sibling',
        parentToolCallId: 'sibling-call',
      }),
    ]);
    const children = await createDelegatedConversationRepository(database).listChildren(
      scope,
      'root'
    );
    expect(children.map((child) => child.threadId).sort()).toEqual(['child', 'sibling']);
    expect(new Set(children.map((child) => child.displayName)).size).toBe(2);
  });
});
