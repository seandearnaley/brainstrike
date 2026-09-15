// @vitest-environment node
/**
 * The flow that failed live three times on 2026-09-14 (threads 22c3279b,
 * 796a942d), through the REAL desktop host, decision ledger and background
 * store: two specialists park on reads under `read: ask`; the user answers ONE
 * card with "Allow reads this session"; the sibling is answered by policy in
 * the same leg, both children run, the parent gets both results once. A
 * one-shot Approve answers only its own card. Script only the model transport
 * and the DB handle, exactly like `delegated-runtime.integration.test.ts`.
 */

import type { StreamChunk } from '@brainstrike/agent';
import {
  hasToolResult,
  parallelToolCallParts,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '@brainstrike/agent/test-fixtures/scripted-agent-model';
import { buildNativeToolRiskMap, getToolActionTarget } from '@brainstrike/assistant-contract';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDesktopDelegatedSuspensionResolver } from '../../assistant-server/delegated-conversation-host';
import { deliverDesktopDelegatedDecision } from '../../assistant-server/delegated-execution-controls';
import { getDesktopMastraMemory } from '../../assistant-server/mastra-memory';
import {
  observeDesktopAssistantRunEvents,
  persistDesktopChildRunUsage,
} from '../../assistant-server/run-persistence';

const holder = vi.hoisted(() => ({
  database: undefined as PGlite | undefined,
  model: undefined as ReturnType<typeof scriptedAgentModel>['model'] | undefined,
}));
vi.mock('../../db-main', () => ({
  getDatabase: async () => {
    if (!holder.database) {
      throw new Error('Database not initialized');
    }
    return holder.database;
  },
}));
// Restore the real runtime: the desktop global setup installs inert agent mocks.
vi.mock('@brainstrike/agent', async (original) => ({
  ...(await original<typeof import('@brainstrike/agent')>()),
}));
vi.mock('@brainstrike/agent/providers/provider-factory', async (original) => ({
  ...(await original<{ createProvider: typeof import('@brainstrike/agent')['createProvider'] }>()),
  createProvider: () => {
    if (!holder.model) {
      throw new Error('Model not initialized');
    }
    return holder.model;
  },
}));
const { listSuspendedMastraRuns, streamMastraAgent, streamMastraToolApprovalAction } = await import(
  '@brainstrike/agent'
);

const settings = {
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    enabled: false,
  },
};
const persona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch', 'brainstrike.readWorkspaceFile'],
  description: 'Find the requested flag.',
  id: 'explore',
  instructions: 'Read and report the flag.',
  label: 'Explorer',
  maxSteps: 8,
};

const READ_ASK: PermissionToolGateSnapshot = {
  policies: { edit: 'deny', execute: 'deny', mcp: 'deny', read: 'ask' },
  riskByTool: buildNativeToolRiskMap(),
  yolo: false,
};
type Policy = PermissionToolGateSnapshot;

type ChildTool =
  | 'brainstrike_grepSearch'
  | 'brainstrike_readWorkspaceFile'
  | 'brainstrike_writeWorkspaceFile';

interface ChildSpec {
  /** A tool the child calls IN PARALLEL with its first call (one model step). */
  readonly alongside?: ChildTool;
  readonly id: string;
  /** A second tool the child calls once the first returned. */
  readonly next?: ChildTool;
  /** The registered (sanitized) ask tool the child calls first. */
  readonly tool: ChildTool;
}

/** A write-capable worker: the only persona kind that may mutate. */
const worker: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch', 'brainstrike.writeWorkspaceFile'],
  description: 'Write the requested flag file.',
  id: 'worker',
  instructions: 'Write the flag and report.',
  label: 'Worker',
  maxSteps: 8,
  mode: 'worker',
};

const EDIT_ASK: PermissionToolGateSnapshot = {
  policies: { edit: 'ask', execute: 'deny', mcp: 'deny', read: 'allow' },
  riskByTool: buildNativeToolRiskMap(),
  yolo: false,
};

/**
 * Fan out `children` as background workers through the real desktop memory,
 * host and ledger. Each child calls its ask-gated tool once and reports
 * `Child: FLAG-<id>`; the root reports `Parent: ALL-FLAGS` once every child
 * has returned and `Parent: waiting` otherwise.
 */
async function setupFanout(
  database: PGlite,
  children: readonly ChildSpec[],
  shape: {
    readonly persona: AssistantPersonaDefinition;
    readonly policy: PermissionToolGateSnapshot;
    /** Resolve to let a grepSearch call return; unset means it returns at once. */
    readonly holdGrep?: Promise<void>;
    /** Observe every root-level chunk of the initial leg as it streams. */
    readonly onInitialChunk?: (chunk: StreamChunk) => void;
  } = { persona, policy: READ_ASK }
) {
  const delegationTool = `agent-${shape.persona.id}`;
  holder.model = scriptedAgentModel((options) => {
    // A child's LAST user message is its delegation prompt ("find flag N");
    // the root's is the task or a background wakeup. Neither tool presence
    // (a WORKER child also holds a delegation tool: every worker fanned out
    // again) nor a whole-prompt marker (the child receives the root's
    // delegated context) identifies the root.
    const prompt = JSON.stringify(options.prompt);
    const lastUser = JSON.stringify(
      options.prompt.filter((message) => message.role === 'user').at(-1)
    );
    const child = children.find((candidate) => lastUser.includes(`find flag ${candidate.id}`));
    if (!child) {
      if (!hasToolResult(options, delegationTool)) {
        return parallelToolCallParts(
          children.map((child) => ({
            args: { prompt: `find flag ${child.id}` },
            toolCallId: `delegate-${child.id}`,
            toolName: delegationTool,
          }))
        );
      }
      const returned = prompt.match(/Child: FLAG-/g)?.length ?? 0;
      return textParts(returned >= children.length ? 'Parent: ALL-FLAGS' : 'Parent: waiting');
    }
    const next = [child.tool, ...(child.next ? [child.next] : [])].find(
      (tool) => !hasToolResult(options, tool)
    );
    if (next === child.tool && child.alongside && !hasToolResult(options, child.alongside)) {
      // The allowed call is issued FIRST so it is already running when the
      // gated one suspends (Mastra kills only the still-queued calls).
      return parallelToolCallParts(
        [child.alongside, child.tool].map((tool) => ({
          args: { pattern: `flag ${child.id}` },
          toolCallId: `child-call-${child.id}-${tool}`,
          toolName: tool,
        }))
      );
    }
    return next
      ? toolCallParts(next, `child-call-${child.id}-${next}`, { pattern: `flag ${child.id}` })
      : textParts(`Child: FLAG-${child.id}`);
  }).model;
  const runtimeMemory = { memorySettings: settings, resourceId: 'owner', threadId: 'root' };
  const execute = vi.fn(async () => {
    await shape.holdGrep;
    return { matches: ['FLAG'] };
  });
  const readFile = vi.fn(async () => ({ content: 'FLAG' }));
  const writeFile = vi.fn(async () => ({ written: true }));
  const baseOptions = {
    model: 'test',
    personas: [shape.persona],
    runtime: {
      apiKey: 'test-key',
      memory: runtimeMemory,
      model: 'test',
      permissionPolicy: shape.policy,
      provider: 'openai' as const,
    },
    tools: {
      'brainstrike.grepSearch': {
        description: 'Read flags',
        execute,
        id: 'brainstrike.grepSearch',
        inputSchema: z.object({ pattern: z.string() }),
      },
      'brainstrike.readWorkspaceFile': {
        description: 'Read a flag file',
        execute: readFile,
        id: 'brainstrike.readWorkspaceFile',
        inputSchema: z.object({ pattern: z.string() }),
      },
      'brainstrike.writeWorkspaceFile': {
        description: 'Write a flag file',
        execute: writeFile,
        id: 'brainstrike.writeWorkspaceFile',
        inputSchema: z.object({ pattern: z.string() }),
      },
    },
  };
  const drain = async (
    stream: AsyncIterable<StreamChunk>,
    hostRunId: string,
    observe?: (chunk: StreamChunk) => void
  ) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of persistDesktopChildRunUsage(
      observeDesktopAssistantRunEvents(stream, hostRunId, [], async () => database),
      hostRunId,
      undefined,
      async () => database,
      true
    )) {
      chunks.push(chunk);
      observe?.(chunk);
    }
    return chunks;
  };
  // Production memory is run-scoped from the request's runtime data; that is
  // what registers the background scope, so the children run as background
  // workers exactly as on the desktop (not foreground).
  const leg = async (hostRunId: string) => ({
    ...baseOptions,
    ...(await getDesktopMastraMemory(settings, hostRunId, undefined, { memory: runtimeMemory })),
  });
  let legs = 0;
  /** Close the previous host leg and open a fresh running one, as the service does. */
  const openLeg = async (): Promise<string> => {
    const previous = legs === 0 ? 'host-leg' : `resume-host-${legs}`;
    legs += 1;
    const next = `resume-host-${legs}`;
    await database.exec(`UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id='${previous}';
      INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id)
      VALUES ('${next}','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'user-turn');`);
    return next;
  };
  const initial = await drain(
    await streamMastraAgent(
      [
        {
          id: 'user-turn',
          parts: [{ text: 'ROOT_RUNTIME_TASK: find every flag', type: 'text' }],
          role: 'user',
        },
      ],
      await leg('host-leg')
    ),
    'host-leg',
    shape.onInitialChunk
  );
  const rootNotices = initial.flatMap((chunk) =>
    chunk.type === 'tool-approval-required' ? [chunk] : []
  );
  const notice = (id: string) => {
    const found = rootNotices.find((chunk) => chunk.toolCallId === `delegate-${id}`);
    if (!found) {
      throw new Error(`Missing the root notice for delegate-${id}`);
    }
    return found;
  };
  const decide = async (
    target: Parameters<typeof getToolActionTarget>[0],
    action: 'approve' | 'decline',
    policy: Policy = shape.policy
  ) => {
    const hostRunId = await openLeg();
    const chunks = await drain(
      await streamMastraToolApprovalAction(
        { ...getToolActionTarget(target), action },
        { ...(await leg(hostRunId)), runtime: { ...baseOptions.runtime, permissionPolicy: policy } }
      ),
      hostRunId
    );
    const failures = chunks.filter(
      (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
    );
    expect(failures, JSON.stringify(failures)).toEqual([]);
    return {
      answered: chunks.flatMap((chunk) =>
        chunk.type === 'tool-approval-answered' ? [chunk.toolCallId] : []
      ),
      text: chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.value] : [])).join(''),
    };
  };
  const decisions = async () =>
    (
      await database.query<{ parent_tool_call_id: string; state: string }>(
        'SELECT parent_tool_call_id, state FROM brainstrike_delegated_tool_decisions ORDER BY parent_tool_call_id'
      )
    ).rows;
  const parkedTasks = async () =>
    (
      await database.query<{ tool_call_id: string }>(
        "SELECT tool_call_id FROM mastra_background_tasks WHERE status = 'suspended' ORDER BY tool_call_id"
      )
    ).rows.map((row) => row.tool_call_id);
  const discover = async () =>
    listSuspendedMastraRuns(
      { resourceId: 'owner', threadId: 'root' },
      {
        ...(await leg(`resume-host-${legs}`)),
        backgroundTaskScope: { resourceId: 'owner', threadId: 'root' },
        delegatedSuspensionDiscovery: createDesktopDelegatedSuspensionResolver(database, {
          ownerResourceId: 'owner',
          rootThreadId: 'root',
        }),
      }
    );
  return {
    decide,
    decisions,
    discover,
    execute,
    initial,
    notice,
    parkedTasks,
    readFile,
    rootNotices,
    writeFile,
  };
}

/** Deliver a decision into the RUNNING initial leg through the desktop registry. */
function deliverLive(
  target: Parameters<typeof getToolActionTarget>[0],
  permissionPolicy?: Policy
): Promise<'delivered' | 'no-live-run'> {
  return deliverDesktopDelegatedDecision('host-leg', {
    action: { ...getToolActionTarget(target), action: 'approve' },
    ...(permissionPolicy ? { permissionPolicy } : {}),
  });
}

describe('desktop multi-approval scenarios through the real host ledger', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await holder.database?.close();
    holder.database = undefined;
    holder.model = undefined;
  });

  let database: PGlite;
  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://delegated-sibling-grant');
    holder.database = database;
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id)
      VALUES ('host-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
        NOW(), NOW(), NOW(), 'user-turn');`);
  });

  const TWO = [
    { id: '1', tool: 'brainstrike_grepSearch' },
    { id: '2', tool: 'brainstrike_grepSearch' },
  ] as const;

  it('every parked child has a root card and no tool ran before a decision', async () => {
    const fanout = await setupFanout(database, TWO);
    expect(fanout.rootNotices.map((chunk) => chunk.toolCallId).sort()).toEqual([
      'delegate-1',
      'delegate-2',
    ]);
    expect(fanout.execute).not.toHaveBeenCalled();
    expect(await fanout.parkedTasks()).toEqual(['delegate-1', 'delegate-2']);
  });

  it('"Allow reads this session" on one card answers the sibling in the same leg', async () => {
    const fanout = await setupFanout(database, TWO);
    const result = await fanout.decide(fanout.notice('1'), 'approve', {
      ...READ_ASK,
      sessionGrants: ['read'],
    });
    expect(result.answered).toEqual(['delegate-2']);
    expect(fanout.execute).toHaveBeenCalledTimes(2);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-1', state: 'consumed' },
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
    ]);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(result.text).toContain('Parent: ALL-FLAGS');
  });

  it('a one-shot Approve answers only its card; approving the sibling next completes the turn', async () => {
    const fanout = await setupFanout(database, TWO);
    const first = await fanout.decide(fanout.notice('1'), 'approve');
    expect(first.answered).toEqual([]);
    expect(fanout.execute).toHaveBeenCalledTimes(1);
    expect(await fanout.parkedTasks()).toEqual(['delegate-2']);
    expect(first.text).toContain('Parent: waiting');
    const second = await fanout.decide(fanout.notice('2'), 'approve');
    expect(second.answered).toEqual([]);
    expect(fanout.execute).toHaveBeenCalledTimes(2);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-1', state: 'consumed' },
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
    ]);
    expect(second.text).toContain('Parent: ALL-FLAGS');
  });

  it('declining one card never runs its tool; a later grant on the sibling touches only the sibling', async () => {
    const fanout = await setupFanout(database, TWO);
    const declined = await fanout.decide(fanout.notice('1'), 'decline');
    expect(declined.answered).toEqual([]);
    expect(fanout.execute).not.toHaveBeenCalled();
    expect(await fanout.parkedTasks()).toEqual(['delegate-2']);
    const granted = await fanout.decide(fanout.notice('2'), 'approve', {
      ...READ_ASK,
      sessionGrants: ['read'],
    });
    // The declined child is no longer parked, so there is nothing to answer.
    expect(granted.answered).toEqual([]);
    expect(fanout.execute).toHaveBeenCalledTimes(1);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-1', state: 'consumed' },
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
    ]);
  });

  it('"Always allow <tool>" answers siblings parked on that tool and leaves a sibling on another tool parked', async () => {
    const fanout = await setupFanout(database, [
      { id: '1', tool: 'brainstrike_grepSearch' },
      { id: '2', tool: 'brainstrike_grepSearch' },
      { id: '3', tool: 'brainstrike_readWorkspaceFile' },
    ]);
    expect(await fanout.parkedTasks()).toEqual(['delegate-1', 'delegate-2', 'delegate-3']);
    const result = await fanout.decide(fanout.notice('1'), 'approve', {
      ...READ_ASK,
      perToolOverrides: { 'brainstrike.grepSearch': 'allow' },
    });
    expect(result.answered).toEqual(['delegate-2']);
    expect(fanout.execute).toHaveBeenCalledTimes(2);
    expect(fanout.readFile).not.toHaveBeenCalled();
    expect(await fanout.parkedTasks()).toEqual(['delegate-3']);
    expect(result.text).toContain('Parent: waiting');
    const third = await fanout.decide(fanout.notice('3'), 'approve');
    expect(fanout.readFile).toHaveBeenCalledTimes(1);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(third.text).toContain('Parent: ALL-FLAGS');
  });

  it('after a reload the rediscovered root cards carry the same identity and a grant answers the sibling', async () => {
    const fanout = await setupFanout(database, TWO);
    const discovered = await fanout.discover();
    expect(discovered.approvals.map((entry) => entry.toolCallId).sort()).toEqual([
      'delegate-1',
      'delegate-2',
    ]);
    const rediscoveredFirst = discovered.approvals.find(
      (entry) => entry.toolCallId === 'delegate-1'
    );
    if (!rediscoveredFirst) {
      throw new Error('Rediscovery lost the first card');
    }
    expect(rediscoveredFirst.delegation).toEqual(fanout.notice('1').delegation);
    const result = await fanout.decide(rediscoveredFirst, 'approve', {
      ...READ_ASK,
      sessionGrants: ['read'],
    });
    expect(result.answered).toEqual(['delegate-2']);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(result.text).toContain('Parent: ALL-FLAGS');
  });

  const TWO_WRITERS = [
    { id: '1', tool: 'brainstrike_writeWorkspaceFile' },
    { id: '2', tool: 'brainstrike_writeWorkspaceFile' },
  ] as const;

  it('worker writes: both children park on the edit, and "Allow edits this session" answers the sibling', async () => {
    const fanout = await setupFanout(database, TWO_WRITERS, { persona: worker, policy: EDIT_ASK });
    expect(fanout.rootNotices.map((chunk) => [chunk.toolCallId, chunk.toolName]).sort()).toEqual([
      ['delegate-1', 'brainstrike.writeWorkspaceFile'],
      ['delegate-2', 'brainstrike.writeWorkspaceFile'],
    ]);
    expect(fanout.rootNotices.map((chunk) => chunk.riskCategory)).toEqual(['edit', 'edit']);
    expect(fanout.writeFile).not.toHaveBeenCalled();
    const result = await fanout.decide(fanout.notice('1'), 'approve', {
      ...EDIT_ASK,
      sessionGrants: ['edit'],
    });
    expect(result.answered).toEqual(['delegate-2']);
    expect(fanout.writeFile).toHaveBeenCalledTimes(2);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(result.text).toContain('Parent: ALL-FLAGS');
  });

  it('worker writes: declining one write never runs it; a read grant on the other answers no write', async () => {
    const fanout = await setupFanout(database, TWO_WRITERS, { persona: worker, policy: EDIT_ASK });
    const declined = await fanout.decide(fanout.notice('1'), 'decline');
    expect(fanout.writeFile).not.toHaveBeenCalled();
    expect(declined.answered).toEqual([]);
    expect(await fanout.parkedTasks()).toEqual(['delegate-2']);
    // A grant for a DIFFERENT category never answers an edit.
    const second = await fanout.decide(fanout.notice('2'), 'approve', {
      ...EDIT_ASK,
      sessionGrants: ['read'],
    });
    expect(second.answered).toEqual([]);
    expect(fanout.writeFile).toHaveBeenCalledTimes(1);
    expect(await fanout.parkedTasks()).toEqual([]);
  });

  it("a parked child's root card publishes while a sibling is still working", async () => {
    // Claude Code surfaces a background subagent's prompt in the main session
    // the moment it asks; here three cards were held 77 s until the slowest
    // sibling returned (thread-4f14436f, 2026-09-14). Child 1's read is
    // allowed and held open; child 2's read asks. Its card must arrive
    // before child 1 is released.
    const hold = Promise.withResolvers<void>();
    let cardSeenWhileSiblingRan = false;
    let released = false;
    const fanout = await setupFanout(
      database,
      [
        { id: '1', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
      ],
      {
        holdGrep: hold.promise,
        onInitialChunk: (chunk) => {
          if (chunk.type === 'tool-approval-required' && chunk.toolCallId === 'delegate-2') {
            cardSeenWhileSiblingRan = !released;
            released = true;
            hold.resolve();
          }
        },
        persona,
        policy: { ...READ_ASK, perToolOverrides: { 'brainstrike.grepSearch': 'allow' } },
      }
    );
    expect(cardSeenWhileSiblingRan).toBe(true);
    expect(fanout.execute).toHaveBeenCalledTimes(1);
    expect(fanout.readFile).not.toHaveBeenCalled();
    expect(await fanout.parkedTasks()).toEqual(['delegate-2']);
  });

  it("a live-resumed child's frames never follow a terminal: its pause finish is held, its own finish is last", async () => {
    // thread-834924c1 (2026-09-14): the child parked at :16 and its pause
    // FINISH was published with the card; the live approve at :23 resumed it
    // in the same leg and its next frames arrived at :26 — after the child
    // view's terminal. The renderer closes a child on its finish frame and
    // tears the whole stream down on any later frame; the host then recorded
    // the run finished and every child died with `delegation-root-not-running`.
    // A parked child is not finished: its pause finish is held for the leg's
    // end and dropped when it resumes, so the only finish it ever sends is
    // its own, last.
    const hold = Promise.withResolvers<void>();
    const childChunks: string[] = [];
    let delivered: Promise<'delivered' | 'no-live-run'> | undefined;
    const fanout = await setupFanout(
      database,
      [
        { id: '1', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
      ],
      {
        holdGrep: hold.promise,
        onInitialChunk: (chunk) => {
          if (
            chunk.type === 'delegated-conversation-chunk' &&
            chunk.identity.parentToolCallId === 'delegate-2'
          ) {
            childChunks.push(
              chunk.chunk.type === 'message-finish'
                ? `message-finish:${chunk.chunk.finishReason}`
                : chunk.chunk.type
            );
          }
          if (
            chunk.type === 'tool-approval-required' &&
            chunk.toolCallId === 'delegate-2' &&
            !delivered
          ) {
            delivered = deliverLive(chunk).finally(() => hold.resolve());
          }
        },
        persona,
        policy: { ...READ_ASK, perToolOverrides: { 'brainstrike.grepSearch': 'allow' } },
      }
    );
    await expect(delivered).resolves.toBe('delivered');
    expect(fanout.readFile).toHaveBeenCalledTimes(1);
    const finishes = childChunks.filter((type) => type.startsWith('message-finish'));
    expect(finishes).toEqual(['message-finish:stop']);
    expect(childChunks.at(-1)).toBe('message-finish:stop');
    // The resumed child's frames (its read result, its answer) came after the card.
    expect(childChunks.indexOf('tool-approval-required')).toBeLessThan(
      childChunks.lastIndexOf('tool-event')
    );
  });

  it('a decision delivered while a sibling still works resumes the parked child inside the running leg', async () => {
    // Claude Code delivers the answer into the live session; here a decision
    // used to start a NEW host leg and wait for the running one to settle.
    // Child 1's allowed read is held open; child 2's read asks; the approve
    // is delivered through the leg's registered control before child 1 is
    // released, so the whole turn completes in ONE leg.
    const hold = Promise.withResolvers<void>();
    let delivered: Promise<'delivered' | 'no-live-run'> | undefined;
    const fanout = await setupFanout(
      database,
      [
        { id: '1', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
      ],
      {
        holdGrep: hold.promise,
        onInitialChunk: (chunk) => {
          if (
            chunk.type === 'tool-approval-required' &&
            chunk.toolCallId === 'delegate-2' &&
            !delivered
          ) {
            delivered = deliverLive(chunk).finally(() => hold.resolve());
          }
        },
        persona,
        policy: { ...READ_ASK, perToolOverrides: { 'brainstrike.grepSearch': 'allow' } },
      }
    );
    await expect(delivered).resolves.toBe('delivered');
    expect(fanout.readFile).toHaveBeenCalledTimes(1);
    const answered = fanout.initial.flatMap((chunk) =>
      chunk.type === 'tool-approval-answered' ? [chunk] : []
    );
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({
      decision: 'approve',
      reason: 'user',
      toolCallId: 'delegate-2',
      toolName: 'brainstrike.readWorkspaceFile',
    });
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
    ]);
    expect(await fanout.parkedTasks()).toEqual([]);
    const text = fanout.initial
      .flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.value] : []))
      .join('');
    expect(text).toContain('Parent: ALL-FLAGS');
  });

  it('a live "Allow reads this session" answers the parked sibling and a child that parks afterwards', async () => {
    // Child 1: allowed held grep, then an ask-gated read AFTER the grant
    // arrived. Child 2: ask-gated read, parked when the grant is delivered on
    // its card. Child 3: parked sibling answered by the grant. A lasting grant
    // applies to every later prompt in the session (Claude Code), so child 1's
    // later read is answered by the remembered grant, never re-asked.
    const hold = Promise.withResolvers<void>();
    let delivered: Promise<'delivered' | 'no-live-run'> | undefined;
    const cards: string[] = [];
    const grant: Policy = {
      ...READ_ASK,
      perToolOverrides: { 'brainstrike.grepSearch': 'allow' },
      sessionGrants: ['read'],
    };
    const fanout = await setupFanout(
      database,
      [
        { id: '1', next: 'brainstrike_readWorkspaceFile', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
        { id: '3', tool: 'brainstrike_readWorkspaceFile' },
      ],
      {
        holdGrep: hold.promise,
        onInitialChunk: (chunk) => {
          if (chunk.type !== 'tool-approval-required') {
            return;
          }
          cards.push(chunk.toolCallId);
          if (cards.includes('delegate-2') && cards.includes('delegate-3') && !delivered) {
            delivered = deliverLive(chunk, grant).finally(() => hold.resolve());
          }
        },
        persona,
        policy: { ...READ_ASK, perToolOverrides: { 'brainstrike.grepSearch': 'allow' } },
      }
    );
    await expect(delivered).resolves.toBe('delivered');
    expect(fanout.readFile).toHaveBeenCalledTimes(3);
    const answered = fanout.initial
      .flatMap((chunk) => (chunk.type === 'tool-approval-answered' ? [chunk] : []))
      .map((chunk) => [chunk.toolCallId, chunk.reason]);
    expect(answered).toHaveLength(3);
    // The card the user answered is the user's; the two others are the grant's.
    expect(answered.filter(([, reason]) => reason === 'user')).toHaveLength(1);
    expect(
      answered
        .filter(([, reason]) => reason === 'session-grant')
        .map(([id]) => id)
        .sort()
    ).toHaveLength(2);
    expect(answered.map(([id]) => id).sort()).toEqual(['delegate-1', 'delegate-2', 'delegate-3']);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-1', state: 'consumed' },
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
      { parent_tool_call_id: 'delegate-3', state: 'consumed' },
    ]);
    expect(await fanout.parkedTasks()).toEqual([]);
    const text = fanout.initial
      .flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.value] : []))
      .join('');
    expect(text).toContain('Parent: ALL-FLAGS');
  });

  it('a decision delivered after the leg settled is not live and changes nothing', async () => {
    const fanout = await setupFanout(database, TWO);
    await expect(deliverLive(fanout.notice('1'))).resolves.toBe('no-live-run');
    expect(fanout.execute).not.toHaveBeenCalled();
    expect(await fanout.decisions()).toEqual([]);
    expect(await fanout.parkedTasks()).toEqual(['delegate-1', 'delegate-2']);
  });
});
