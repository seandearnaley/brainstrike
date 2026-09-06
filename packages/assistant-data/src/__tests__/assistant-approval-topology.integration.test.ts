import {
  type RediscoveredToolApproval,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-suspend';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from '../assistant-memory-repository';
import { createMigratedTestPGlite } from './helpers/test-pglite';

/**
 * BST-1243: approval/suspend flows must never corrupt durable branch topology.
 *
 * The "Approved <tool>." action echo and the post-approval resume leg are
 * UI-transport bookkeeping that Mastra deliberately never persists as rows
 * (assistant-persistence.md). The history adapter therefore must not persist
 * parent edges for them, and every edge it DOES persist must reference a
 * durable message id (or null) — otherwise reload hydration re-roots the next
 * user message and a linear conversation fans out into root carousel siblings
 * (the 3-exchanges-become-3/3 regression, 4th recurrence of this class).
 *
 * These cases drive the REAL adapter over the REAL repository + PGlite in the
 * exact append order the live assistant-ui runtime produced in the affected
 * database (thread-4ecafac2, 2026-08-10) — never hand-idealized sequences.
 */

let pgliteDataDirCounter = 0;

function createPgliteTestDataDir(prefix: string): string {
  pgliteDataDirCounter += 1;
  return `memory://${prefix}-${pgliteDataDirCounter}`;
}

type AdapterAppendItem = Parameters<
  ReturnType<typeof createAssistantThreadHistoryAdapter>['append']
>[0];

function userAppendItem(args: {
  id: string;
  parentId: string | null;
  text: string;
  custom?: Record<string, unknown>;
}): AdapterAppendItem {
  return {
    message: {
      attachments: [],
      content: [{ text: args.text, type: 'text' }],
      createdAt: new Date(),
      id: args.id,
      metadata: { custom: args.custom ?? {} },
      role: 'user',
    },
    parentId: args.parentId,
  } as AdapterAppendItem;
}

function assistantAppendItem(args: {
  id: string;
  parentId: string | null;
  text: string;
}): AdapterAppendItem {
  return {
    message: {
      content: [{ text: args.text, type: 'text' }],
      createdAt: new Date(),
      id: args.id,
      metadata: {
        custom: {},
        steps: [],
        // biome-ignore lint/style/useNamingConvention: assistant-ui metadata key.
        unstable_annotations: [],
        // biome-ignore lint/style/useNamingConvention: assistant-ui metadata key.
        unstable_data: [],
        // biome-ignore lint/style/useNamingConvention: assistant-ui metadata key.
        unstable_state: null,
      },
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' },
    },
    parentId: args.parentId,
  } as AdapterAppendItem;
}

function approveEchoItem(args: {
  id: string;
  parentId: string;
  runId?: string;
  toolCallId?: string;
}): AdapterAppendItem {
  return userAppendItem({
    custom: {
      [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
        action: 'approve',
        runId: args.runId ?? 'run-1',
        toolCallId: args.toolCallId ?? 'call-1',
        toolName: 'brainstrike.executeCommand',
      },
    },
    id: args.id,
    parentId: args.parentId,
    text: 'Approved brainstrike.executeCommand.',
  });
}

async function insertMastraMessage(
  db: Pick<DbHandle, 'query'>,
  args: {
    createdAt: string;
    id: string;
    role: 'assistant' | 'user';
    text: string;
    threadId: string;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO mastra_messages
      (id, thread_id, content, role, type, "createdAt", "resourceId")
     VALUES ($1, $2, $3::jsonb, $4, 'v2', $5, $6)`,
    [
      args.id,
      args.threadId,
      JSON.stringify({
        content: args.text,
        format: 2,
        parts: [{ text: args.text, type: 'text' }],
      }),
      args.role,
      new Date(args.createdAt),
      'workspace-a',
    ]
  );
}

async function readEdges(
  db: Pick<DbHandle, 'query'>,
  threadId: string
): Promise<[string, string | null][]> {
  const result = await db.query<{ message_id: string; parent_id: string | null }>(
    `SELECT message_id, parent_id FROM brainstrike_assistant_message_parents
     WHERE thread_id = $1 ORDER BY created_at ASC, message_id ASC`,
    [threadId]
  );
  return result.rows.map((row) => [row.message_id, row.parent_id]);
}

function makeApproval(overrides: Partial<RediscoveredToolApproval>): RediscoveredToolApproval {
  return {
    runId: 'run-1',
    stale: false,
    suspendedAt: '2026-08-10T17:19:40.000Z',
    toolCallId: 'call-1',
    toolName: 'brainstrike.executeCommand',
    ...overrides,
  };
}

describe('approval/suspend branch topology (BST-1243)', () => {
  let pgliteDataDir: string | undefined;

  async function makeHarness(prefix: string) {
    pgliteDataDir = createPgliteTestDataDir(prefix);
    const db = (await createMigratedTestPGlite(pgliteDataDir)) as DbHandle;
    const repository = createPgliteAssistantThreadRepository(db);
    const thread = await repository.createThread('workspace-a');
    const makeAdapter = () =>
      createAssistantThreadHistoryAdapter({
        repository,
        resourceId: 'workspace-a',
        threadId: thread.id,
      });
    const seedRun = async (runId: string, turnMessageId: string) => {
      await repository.createThreadRun({
        id: runId,
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        resourceId: 'workspace-a',
        runtimeKind: 'hosted',
        threadId: thread.id,
        turnMessageId,
      });
    };
    return { db, makeAdapter, repository, seedRun, threadId: thread.id };
  }

  it('keeps a live conversation with a mid-thread approval linear across reload', async () => {
    const { db, makeAdapter, threadId } = await makeHarness('approval-linear-topology');
    const adapter = makeAdapter();

    // Live sequence exactly as the runtime produced it in the affected DB:
    // user turn 1 → assistant suspends on an approval → echo → resume leg →
    // user turn 2 → assistant turn 2 (no approval).
    await adapter.append(userAppendItem({ id: 'user-1', parentId: null, text: 'first prompt' }));
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:17:22Z',
      id: 'user-1',
      role: 'user',
      text: 'first prompt',
      threadId,
    });
    // Mastra saves the suspended assistant snapshot under the ALIGNED id.
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:17:29Z',
      id: 'assistant-a',
      role: 'assistant',
      text: 'working on it (suspended at approval)',
      threadId,
    });
    // The library never fires assistant-a's own runEnd history append —
    // suspension interrupts it. The echo is appended as assistant-a's child.
    await adapter.append(approveEchoItem({ id: 'echo-1', parentId: 'assistant-a' }));
    // Post-resume continuation persists under a FRESH Mastra-minted id.
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:20:01Z',
      id: '611ab3ac-cont',
      role: 'assistant',
      text: 'continuation after approval',
      threadId,
    });
    // The resume leg occupies a transient assistant-ui message; its runEnd
    // append chains onto the echo.
    await adapter.append(
      assistantAppendItem({ id: 'resume-leg-1', parentId: 'echo-1', text: 'continuation' })
    );
    // Next REAL user turn captures its parent from the in-memory tail.
    await adapter.append(
      userAppendItem({ id: 'user-2', parentId: 'resume-leg-1', text: 'second prompt' })
    );
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:22:26Z',
      id: 'user-2',
      role: 'user',
      text: 'second prompt',
      threadId,
    });
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:22:43Z',
      id: 'assistant-b',
      role: 'assistant',
      text: 'plain reply',
      threadId,
    });
    await adapter.append(
      assistantAppendItem({ id: 'assistant-b', parentId: 'user-2', text: 'plain reply' })
    );

    // Durable-parent invariant: every persisted edge references a durable id
    // (or null); the transient echo/resume ids never appear.
    const edges = await readEdges(db, threadId);
    expect(edges).toEqual(
      expect.arrayContaining([
        ['user-1', null],
        ['assistant-a', 'user-1'],
        ['user-2', 'assistant-a'],
        ['assistant-b', 'user-2'],
      ])
    );
    expect(edges).toHaveLength(4);

    // Reload (fresh adapter instance = fresh session state): linear chain.
    const history = await makeAdapter().load();
    const roots = history.messages.filter((item) => item.parentId === null);
    expect(roots.map((item) => item.message.id)).toEqual(['user-1']);
    expect(history.messages.map((item) => [item.message.id, item.parentId])).toEqual([
      ['user-1', null],
      ['assistant-a', 'user-1'],
      ['user-2', 'assistant-a'],
      ['assistant-b', 'user-2'],
    ]);
    expect(history.headId).toBe('assistant-b');
  });

  it('keeps a post-restart rediscovered approval linear across the next reload', async () => {
    const { db, makeAdapter, repository, threadId } = await makeHarness(
      'rediscovered-approval-topology'
    );

    // Pre-restart state: user turn persisted with its edge; the assistant
    // suspended at an approval, so its row exists but its edge was never
    // appended. The app then restarted.
    await repository.recordMessageParent({
      messageId: 'user-1',
      parentId: null,
      resourceId: 'workspace-a',
      threadId,
    });
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:17:22Z',
      id: 'user-1',
      role: 'user',
      text: 'first prompt',
      threadId,
    });
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:17:29Z',
      id: 'assistant-a',
      role: 'assistant',
      text: 'working on it (suspended at approval)',
      threadId,
    });

    const rediscoveryAdapter = createAssistantThreadHistoryAdapter({
      discoverSuspendedRuns: async () => ({
        approvals: [makeApproval({})],
        suspends: [],
      }),
      repository,
      resourceId: 'workspace-a',
      threadId,
    });
    const rediscovered = await rediscoveryAdapter.load();
    expect(rediscovered.headId).toBe('suspended-approval:run-1:call-1');

    // The user approves from the rediscovered notice: the echo chains onto
    // the SYNTHETIC pause message id, then the resume leg and next turn.
    await rediscoveryAdapter.append(
      approveEchoItem({ id: 'echo-1', parentId: 'suspended-approval:run-1:call-1' })
    );
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:20:01Z',
      id: 'cont-after-restart',
      role: 'assistant',
      text: 'continuation after restart approval',
      threadId,
    });
    await rediscoveryAdapter.append(
      assistantAppendItem({ id: 'resume-leg-1', parentId: 'echo-1', text: 'continuation' })
    );
    await rediscoveryAdapter.append(
      userAppendItem({ id: 'user-2', parentId: 'resume-leg-1', text: 'second prompt' })
    );
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:22:26Z',
      id: 'user-2',
      role: 'user',
      text: 'second prompt',
      threadId,
    });

    const edges = await readEdges(db, threadId);
    expect(edges).toEqual(
      expect.arrayContaining([
        ['user-1', null],
        ['assistant-a', 'user-1'],
        ['user-2', 'assistant-a'],
      ])
    );
    expect(edges).toHaveLength(3);

    const history = await makeAdapter().load();
    const roots = history.messages.filter((item) => item.parentId === null);
    expect(roots.map((item) => item.message.id)).toEqual(['user-1']);
    expect(history.messages.map((item) => [item.message.id, item.parentId])).toEqual([
      ['user-1', null],
      ['assistant-a', 'user-1'],
      ['user-2', 'assistant-a'],
    ]);
  });

  it('treats a suspend() typed-resume echo with the same durable-parent discipline', async () => {
    const { db, makeAdapter, threadId } = await makeHarness('suspend-resume-topology');
    const adapter = makeAdapter();

    await adapter.append(userAppendItem({ id: 'user-1', parentId: null, text: 'first prompt' }));
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:17:22Z',
      id: 'user-1',
      role: 'user',
      text: 'first prompt',
      threadId,
    });
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:17:29Z',
      id: 'assistant-a',
      role: 'assistant',
      text: 'which region? (suspended)',
      threadId,
    });
    await adapter.append(
      userAppendItem({
        custom: {
          [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
            resumeData: { region: 'us-east-1' },
            runId: 'run-1',
            toolCallId: 'call-1',
            toolName: 'brainstrike.askUser',
          },
        },
        id: 'suspend-echo-1',
        parentId: 'assistant-a',
        text: 'Answered brainstrike.askUser.',
      })
    );
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:20:01Z',
      id: 'cont-suspend',
      role: 'assistant',
      text: 'continuation after typed resume',
      threadId,
    });
    await adapter.append(
      assistantAppendItem({ id: 'resume-leg-1', parentId: 'suspend-echo-1', text: 'continuation' })
    );
    await adapter.append(
      userAppendItem({ id: 'user-2', parentId: 'resume-leg-1', text: 'second prompt' })
    );
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:22:26Z',
      id: 'user-2',
      role: 'user',
      text: 'second prompt',
      threadId,
    });

    const edges = await readEdges(db, threadId);
    expect(edges).toEqual(
      expect.arrayContaining([
        ['user-1', null],
        ['assistant-a', 'user-1'],
        ['user-2', 'assistant-a'],
      ])
    );
    expect(edges).toHaveLength(3);

    const history = await makeAdapter().load();
    expect(history.messages.filter((item) => item.parentId === null)).toHaveLength(1);
  });

  it('persists a normal edge for a user message carrying an INVALID action marker', async () => {
    // Strict-guard symmetry with the transport: a record-but-invalid marker is
    // NOT an action — the message ships on the wire, Mastra persists it, and
    // its topology edge must be recorded like any ordinary prompt.
    const { db, makeAdapter, threadId } = await makeHarness('invalid-marker-topology');
    const adapter = makeAdapter();

    await adapter.append(userAppendItem({ id: 'user-1', parentId: null, text: 'first prompt' }));
    await adapter.append(
      userAppendItem({
        custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: {} },
        id: 'user-invalid-marker',
        parentId: 'user-1',
        text: 'looks like an echo but is a real prompt',
      })
    );

    const edges = await readEdges(db, threadId);
    expect(edges).toEqual(
      expect.arrayContaining([
        ['user-1', null],
        ['user-invalid-marker', 'user-1'],
      ])
    );
    expect(edges).toHaveLength(2);
  });

  it('regenerated responses after an approval turn remain genuine carousel siblings', async () => {
    // Aliasing must never collapse REAL branches: a regeneration branches from
    // the user prompt with durable ids on both siblings.
    const { db, makeAdapter, threadId } = await makeHarness('approval-regeneration-siblings');
    const adapter = makeAdapter();

    await adapter.append(userAppendItem({ id: 'user-1', parentId: null, text: 'first prompt' }));
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:17:22Z',
      id: 'user-1',
      role: 'user',
      text: 'first prompt',
      threadId,
    });
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:17:29Z',
      id: 'assistant-a',
      role: 'assistant',
      text: 'first answer (suspended at approval)',
      threadId,
    });
    await adapter.append(approveEchoItem({ id: 'echo-1', parentId: 'assistant-a' }));
    await adapter.append(
      assistantAppendItem({ id: 'resume-leg-1', parentId: 'echo-1', text: 'continuation' })
    );
    // Regenerate: a fresh durable assistant id branching from the prompt.
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:21:00Z',
      id: 'assistant-regen',
      role: 'assistant',
      text: 'regenerated answer',
      threadId,
    });
    await adapter.append(
      assistantAppendItem({ id: 'assistant-regen', parentId: 'user-1', text: 'regenerated answer' })
    );

    const edges = await readEdges(db, threadId);
    expect(edges).toEqual(
      expect.arrayContaining([
        ['user-1', null],
        ['assistant-a', 'user-1'],
        ['assistant-regen', 'user-1'],
      ])
    );
    expect(edges).toHaveLength(3);

    const history = await makeAdapter().load();
    const assistantSiblings = history.messages.filter((item) => item.parentId === 'user-1');
    expect(assistantSiblings.map((item) => item.message.id).sort()).toEqual([
      'assistant-a',
      'assistant-regen',
    ]);
  });

  it('backfills a suspended regeneration via the run turn link, preserving the source branch', async () => {
    // PR #2392 review (Codex P1 / Claude #1): a regeneration branched from an
    // OLDER prompt that suspends must not have its edge guessed from the
    // session tail — the run's turn_message_id (BST-1163) is the durable,
    // exact anchor and keeps the genuine carousel sibling.
    const { db, makeAdapter, seedRun, threadId } = await makeHarness('regen-suspend-turn-link');

    for (const [id, text, role, createdAt] of [
      ['user-1', 'first prompt', 'user', '2026-08-10T17:00:00Z'],
      ['assistant-1', 'first answer', 'assistant', '2026-08-10T17:00:05Z'],
      ['user-2', 'second prompt', 'user', '2026-08-10T17:01:00Z'],
      ['assistant-2', 'second answer', 'assistant', '2026-08-10T17:01:05Z'],
    ] as const) {
      await insertMastraMessage(db, { createdAt, id, role, text, threadId });
    }
    const seedRepository = createPgliteAssistantThreadRepository(db);
    for (const edge of [
      { messageId: 'user-1', parentId: null },
      { messageId: 'assistant-1', parentId: 'user-1' },
      { messageId: 'user-2', parentId: 'assistant-1' },
      { messageId: 'assistant-2', parentId: 'user-2' },
    ] as const) {
      await seedRepository.recordMessageParent({
        ...edge,
        resourceId: 'workspace-a',
        threadId,
      });
    }

    const adapter = makeAdapter();
    await adapter.load();

    // Regeneration of assistant-1: a NEW run whose turn link is the REUSED
    // user message (user-1), streaming a fresh aligned assistant id that
    // suspends at an approval before its runEnd append can fire.
    await seedRun('run-regen', 'user-1');
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:02:00Z',
      id: 'assistant-regen',
      role: 'assistant',
      text: 'regenerated (suspended at approval)',
      threadId,
    });
    await adapter.append(
      approveEchoItem({ id: 'echo-1', parentId: 'assistant-regen', runId: 'run-regen' })
    );

    const edges = await readEdges(db, threadId);
    // The backfill anchors to the turn link (user-1) — NOT the session tail
    // (assistant-2), which would fold the regeneration into the wrong branch.
    expect(edges).toContainEqual(['assistant-regen', 'user-1']);
    expect(edges).toHaveLength(5);

    const history = await makeAdapter().load();
    const siblings = history.messages.filter((item) => item.parentId === 'user-1');
    expect(siblings.map((item) => item.message.id).sort()).toEqual([
      'assistant-1',
      'assistant-regen',
    ]);
  });

  it('does not mis-parent the suspended message when other sends land during the suspension', async () => {
    // PR #2392 review (Claude #1): the user can keep typing while an approval
    // notice is pending. The echo's parent is then the CURRENT tail (already
    // edged), so no backfill fires and no guessed edge is written for it.
    const { db, makeAdapter, seedRun, threadId } = await makeHarness('mid-suspension-send');
    const adapter = makeAdapter();

    await adapter.append(userAppendItem({ id: 'user-1', parentId: null, text: 'first prompt' }));
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:00:00Z',
      id: 'user-1',
      role: 'user',
      text: 'first prompt',
      threadId,
    });
    await seedRun('run-suspended', 'user-1');
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:00:05Z',
      id: 'assistant-a',
      role: 'assistant',
      text: 'suspended at approval',
      threadId,
    });
    // The user types again while the notice is pending: a full second turn.
    await adapter.append(
      userAppendItem({ id: 'user-2', parentId: 'assistant-a', text: 'second prompt' })
    );
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:00:30Z',
      id: 'user-2',
      role: 'user',
      text: 'second prompt',
      threadId,
    });
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:00:35Z',
      id: 'assistant-2',
      role: 'assistant',
      text: 'second answer',
      threadId,
    });
    await adapter.append(
      assistantAppendItem({ id: 'assistant-2', parentId: 'user-2', text: 'second answer' })
    );
    // NOW the user approves the still-pending run-1 notice; the echo appends
    // at the thread tail (assistant-2), which already has its edge.
    await adapter.append(
      approveEchoItem({ id: 'echo-1', parentId: 'assistant-2', runId: 'run-suspended' })
    );
    await adapter.append(
      assistantAppendItem({ id: 'resume-leg-1', parentId: 'echo-1', text: 'continuation' })
    );
    await adapter.append(
      userAppendItem({ id: 'user-3', parentId: 'resume-leg-1', text: 'third prompt' })
    );
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:01:10Z',
      id: 'user-3',
      role: 'user',
      text: 'third prompt',
      threadId,
    });

    const edges = await readEdges(db, threadId);
    expect(edges).toEqual(
      expect.arrayContaining([
        ['user-1', null],
        ['user-2', 'assistant-a'],
        ['assistant-2', 'user-2'],
        ['user-3', 'assistant-2'],
      ])
    );
    // Crucially: NO backfilled edge claiming the suspended assistant-a is a
    // child of anything later than its own turn, and no echo/resume edges.
    expect(edges).toHaveLength(4);

    const history = await makeAdapter().load();
    expect(history.messages.filter((item) => item.parentId === null)).toHaveLength(1);
    expect(history.messages.map((item) => [item.message.id, item.parentId])).toEqual([
      ['user-1', null],
      ['assistant-a', 'user-1'],
      ['user-2', 'assistant-a'],
      ['assistant-2', 'user-2'],
      ['user-3', 'assistant-2'],
    ]);
  });

  it('pins multi-pause rediscovery: approving an older notice continues from the durable head', async () => {
    // PR #2392 review (Codex P1 #2) — SETTLED the other way, deliberately:
    // a resumed old run's continuation rows land chronologically at the END
    // of mastra_messages, so the durable topology anchors the follow-up at
    // the thread head where that content actually hydrates. Re-parenting it
    // under the old run's mid-thread assistant would fabricate a mid-thread
    // branch whose content lives at the bottom — a worse corruption.
    const { db, makeAdapter, repository, threadId } = await makeHarness('multi-pause-rediscovery');

    for (const [id, text, role, createdAt] of [
      ['user-1', 'first prompt', 'user', '2026-08-10T17:00:00Z'],
      ['assistant-a', 'older suspended run', 'assistant', '2026-08-10T17:00:05Z'],
      ['user-2', 'second prompt', 'user', '2026-08-10T17:01:00Z'],
      ['assistant-b', 'newer suspended run', 'assistant', '2026-08-10T17:01:05Z'],
    ] as const) {
      await insertMastraMessage(db, { createdAt, id, role, text, threadId });
    }
    await repository.recordMessageParent({
      messageId: 'user-1',
      parentId: null,
      resourceId: 'workspace-a',
      threadId,
    });
    await repository.recordMessageParent({
      messageId: 'user-2',
      parentId: 'assistant-a',
      resourceId: 'workspace-a',
      threadId,
    });

    const adapter = createAssistantThreadHistoryAdapter({
      discoverSuspendedRuns: async () => ({
        approvals: [
          makeApproval({
            runId: 'run-a',
            suspendedAt: '2026-08-10T17:00:06.000Z',
            toolCallId: 'call-a',
          }),
          makeApproval({
            runId: 'run-b',
            suspendedAt: '2026-08-10T17:01:06.000Z',
            toolCallId: 'call-b',
          }),
        ],
        suspends: [],
      }),
      repository,
      resourceId: 'workspace-a',
      threadId,
    });
    await adapter.load();

    // Approving the OLDER notice: the echo still appends at the thread tail
    // (the newest synthetic), and resolves through the alias chain to the
    // durable head assistant-b.
    await adapter.append(
      approveEchoItem({
        id: 'echo-old',
        parentId: 'suspended-approval:run-b:call-b',
        runId: 'run-a',
        toolCallId: 'call-a',
      })
    );
    await adapter.append(
      assistantAppendItem({ id: 'resume-leg-old', parentId: 'echo-old', text: 'continuation' })
    );
    await adapter.append(
      userAppendItem({ id: 'user-3', parentId: 'resume-leg-old', text: 'third prompt' })
    );
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:02:00Z',
      id: 'user-3',
      role: 'user',
      text: 'third prompt',
      threadId,
    });

    const edges = await readEdges(db, threadId);
    expect(edges).toEqual(
      expect.arrayContaining([
        ['user-1', null],
        ['user-2', 'assistant-a'],
        ['assistant-b', 'user-2'],
        ['user-3', 'assistant-b'],
      ])
    );
    expect(edges).toHaveLength(4);

    const history = await makeAdapter().load();
    expect(history.messages.filter((item) => item.parentId === null)).toHaveLength(1);
  });

  it('pins the v1 stance: regenerating a post-approval response is not a persisted branch', async () => {
    // PR #2392 review (Claude #3): a regeneration taken from the resume-leg
    // message re-appends with the ECHO as parent and is structurally
    // indistinguishable from a resume leg at this seam, so its edge is
    // deliberately not persisted. Content is never lost — the Mastra row
    // hydrates chronologically inside the turn's group.
    const { db, makeAdapter, threadId } = await makeHarness('post-approval-regen-drop');
    const adapter = makeAdapter();

    await adapter.append(userAppendItem({ id: 'user-1', parentId: null, text: 'first prompt' }));
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:00:00Z',
      id: 'user-1',
      role: 'user',
      text: 'first prompt',
      threadId,
    });
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:00:05Z',
      id: 'assistant-a',
      role: 'assistant',
      text: 'suspended at approval',
      threadId,
    });
    await adapter.append(approveEchoItem({ id: 'echo-1', parentId: 'assistant-a' }));
    await adapter.append(
      assistantAppendItem({ id: 'resume-leg-1', parentId: 'echo-1', text: 'continuation' })
    );
    // Regenerate the post-approval response: assistant-ui re-appends the new
    // aligned message with the echo as parent.
    await insertMastraMessage(db, {
      createdAt: '2026-08-10T17:00:40Z',
      id: 'assistant-regen',
      role: 'assistant',
      text: 'regenerated continuation',
      threadId,
    });
    await adapter.append(
      assistantAppendItem({
        id: 'assistant-regen',
        parentId: 'echo-1',
        text: 'regenerated continuation',
      })
    );

    const edges = await readEdges(db, threadId);
    expect(edges).toEqual(
      expect.arrayContaining([
        ['user-1', null],
        ['assistant-a', 'user-1'],
      ])
    );
    expect(edges).toHaveLength(2);

    const history = await makeAdapter().load();
    expect(history.messages.filter((item) => item.parentId === null)).toHaveLength(1);
    // The regenerated content survives reload inside the turn's group.
    const combined = JSON.stringify(history.messages.map((item) => item.message.content));
    expect(combined).toContain('regenerated continuation');
  });
});
