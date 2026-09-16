/**
 * The real-host approval harness shared by the delegated approval suites: one
 * scripted fan-out of background children through the REAL desktop memory,
 * host and ledger, plus the ledger reads and stand-ins those suites assert on.
 * Only the model transport and the DB handle are scripted.
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
import { expect, vi } from 'vitest';
import { z } from 'zod';
import { createDesktopDelegatedSuspensionResolver } from '../../../assistant-server/delegated-conversation-host';
import { deliverDesktopDelegatedDecision } from '../../../assistant-server/delegated-execution-controls';
import { getDesktopMastraMemory } from '../../../assistant-server/mastra-memory';
import {
  observeDesktopAssistantRunEvents,
  persistDesktopChildRunUsage,
} from '../../../assistant-server/run-persistence';

const settings = {
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    enabled: false,
  },
};
export const persona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch', 'brainstrike.readWorkspaceFile'],
  description: 'Find the requested flag.',
  id: 'explore',
  instructions: 'Read and report the flag.',
  label: 'Explorer',
  maxSteps: 8,
};

export const READ_ASK: PermissionToolGateSnapshot = {
  policies: { edit: 'deny', execute: 'deny', mcp: 'deny', read: 'ask' },
  riskByTool: buildNativeToolRiskMap(),
  yolo: false,
};
export type Policy = PermissionToolGateSnapshot;

export type ChildTool =
  | 'brainstrike_grepSearch'
  | 'brainstrike_readWorkspaceFile'
  | 'brainstrike_writeWorkspaceFile';

export interface ChildSpec {
  /** A tool the child calls IN PARALLEL with its first call (one model step). */
  readonly alongside?: ChildTool;
  readonly id: string;
  /** A second tool the child calls once the first returned. */
  readonly next?: ChildTool;
  /** The registered (sanitized) ask tool the child calls first. */
  readonly tool: ChildTool;
}

/** A write-capable worker: the only persona kind that may mutate. */
export const worker: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch', 'brainstrike.writeWorkspaceFile'],
  description: 'Write the requested flag file.',
  id: 'worker',
  instructions: 'Write the flag and report.',
  label: 'Worker',
  maxSteps: 8,
  mode: 'worker',
};

export const EDIT_ASK: PermissionToolGateSnapshot = {
  policies: { edit: 'ask', execute: 'deny', mcp: 'deny', read: 'allow' },
  riskByTool: buildNativeToolRiskMap(),
  yolo: false,
};

export interface FanoutShape {
  /** Resolve to let a grepSearch call return; unset means it returns at once. */
  readonly holdGrep?: Promise<void>;
  /** Observe every root-level chunk of the initial leg as it streams. */
  readonly onInitialChunk?: (chunk: StreamChunk) => void;
  readonly persona: AssistantPersonaDefinition;
  readonly policy: PermissionToolGateSnapshot;
}

/** The `vi.hoisted` state a test file's module mocks read. */
export interface FanoutHolder {
  database: PGlite | undefined;
  model: ReturnType<typeof scriptedAgentModel>['model'] | undefined;
}

/** Two specialists that both park on the same gated read. */
export const TWO = [
  { id: '1', tool: 'brainstrike_grepSearch' },
  { id: '2', tool: 'brainstrike_grepSearch' },
] as const satisfies readonly ChildSpec[];

/** A migrated database seeded with the root thread and its first running leg. */
export async function createApprovalDatabase(name: string): Promise<PGlite> {
  const database = await wasmLoader.createPGlite(name);
  await migrate(database);
  await database.exec(`INSERT INTO mastra_threads
    (id, "resourceId", title, metadata, "createdAt", "updatedAt")
    VALUES ('root', 'owner', 'Root', '{}', NOW(), NOW());
    INSERT INTO brainstrike_assistant_thread_runs
    (id, resource_id, thread_id, provider, model, runtime_kind, status,
     started_at, created_at, updated_at, turn_message_id)
    VALUES ('host-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
      NOW(), NOW(), NOW(), 'user-turn');`);
  return database;
}

/**
 * Fan out `children` as background workers through the real desktop memory,
 * host and ledger. Each child calls its ask-gated tool once and reports
 * `Child: FLAG-<id>`; the root reports `Parent: ALL-FLAGS` once every child
 * has returned and `Parent: waiting` otherwise.
 */
export async function setupFanout(
  holder: FanoutHolder,
  database: PGlite,
  children: readonly ChildSpec[],
  shape: FanoutShape = { persona, policy: READ_ASK }
) {
  // Imported here, not at module scope: a test file's `vi.mock` calls are
  // hoisted above its imports, so this resolves the restored real runtime.
  const { listSuspendedMastraRuns, streamMastraAgent, streamMastraToolApprovalAction } =
    await import('@brainstrike/agent');
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
    // A root wakeup is the whole ledger and QUOTES each child's prompt
    // (WAKEUP LEDGER, 2026-09-15), so it is told apart by its header before
    // the prompt text is used to pick a child.
    const wakeup = lastUser.includes('Background invocations of this turn');
    const child = wakeup
      ? undefined
      : children.find((candidate) => lastUser.includes(`find flag ${candidate.id}`));
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
    policy: Policy = shape.policy,
    observe?: (chunk: StreamChunk, hostRunId: string) => void
  ) => {
    const hostRunId = await openLeg();
    const chunks = await drain(
      await streamMastraToolApprovalAction(
        { ...getToolActionTarget(target), action },
        { ...(await leg(hostRunId)), runtime: { ...baseOptions.runtime, permissionPolicy: policy } }
      ),
      hostRunId,
      observe ? (chunk) => observe(chunk, hostRunId) : undefined
    );
    const failures = chunks.filter(
      (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
    );
    expect(failures, JSON.stringify(failures)).toEqual([]);
    return {
      answered: chunks.flatMap((chunk) =>
        chunk.type === 'tool-approval-answered' ? [chunk.toolCallId] : []
      ),
      /** Root cards this leg published — a resumed child that parks again adds one. */
      cards: chunks.flatMap((chunk) =>
        chunk.type === 'tool-approval-required' ? [chunk.toolCallId] : []
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
export function deliverLive(
  target: Parameters<typeof getToolActionTarget>[0],
  permissionPolicy?: Policy,
  hostRunId = 'host-leg'
): Promise<'delivered' | 'no-live-run'> {
  return deliverDesktopDelegatedDecision(hostRunId, {
    action: { ...getToolActionTarget(target), action: 'approve' },
    ...(permissionPolicy ? { permissionPolicy } : {}),
  });
}

/** The leaf call id a root card decides on, named by the card it came from. */
function leafOf(card: {
  readonly delegation?: { readonly toolCallId: string };
  readonly toolCallId: string;
}): string {
  const leaf = card.delegation?.toolCallId;
  if (!leaf) {
    throw new Error(`The root card for ${card.toolCallId} carries no leaf identity`);
  }
  return leaf;
}

/**
 * Stand in for a concurrent answer to `card`'s leaf that landed first: its
 * ledger row is consumed while its background task is still suspended (Mastra
 * flips the task row only when its worker picks the resume up).
 */
export async function answerLeafConcurrently(
  database: PGlite,
  card: { readonly delegation?: { readonly toolCallId: string }; readonly toolCallId: string }
): Promise<void> {
  const inserted = await database.query(
    `INSERT INTO brainstrike_delegated_tool_decisions
      (id, owner_resource_id, root_thread_id, parent_runtime_run_id, parent_tool_call_id,
       child_thread_id, child_runtime_run_id, tool_call_id, host_run_id, state, finished_at)
     SELECT 'concurrent-answer', 'owner', 'root', parent_runtime_run_id, parent_tool_call_id,
       thread_id, child_runtime_run_id, $1, 'host-leg', 'consumed', NOW()
     FROM brainstrike_delegated_invocations
     WHERE root_thread_id = 'root' AND parent_tool_call_id = $2
     RETURNING id`,
    [leafOf(card), card.toolCallId]
  );
  expect(inserted.rows).toHaveLength(1);
}

/**
 * Stop the child behind `card`: its subtree carries a cancellation request for
 * this turn while its background task is still suspended — the state a Stop
 * that never reached `cancelStoredBackgroundInvocations` leaves behind. A
 * grant skips such a sibling at discovery instead of refusing over it.
 */
export async function stopSubtree(
  database: PGlite,
  card: { readonly toolCallId: string }
): Promise<void> {
  const stopped = await database.query(
    `UPDATE brainstrike_delegated_invocations SET cancellation_requested_at = NOW()
     WHERE root_thread_id = 'root' AND parent_tool_call_id = $1 RETURNING thread_id`,
    [card.toolCallId]
  );
  expect(stopped.rows).toHaveLength(1);
}

/**
 * Answer `card`'s leaf inside the WINDOW between a grant's discovery read and
 * its answer write, by hooking the host's own `unanswerable` read on the way
 * out. Discovery therefore saw the leaf answerable and the refusal can land
 * only on the write — the race ALL-OR-NONE exists for, and the only fatal
 * per-sibling refusal left now that discovery skips answered and stopped
 * leaves. The window is inside ONE host call with no seam to hook from
 * outside, so the anchor is that read's own CTE name.
 *
 * Returns a disposer the caller MUST run: the patch is removed unconditionally
 * (a rejecting query in the interval, or an anchor that never matches, would
 * otherwise leave a shared handle patched into teardown), and disposing also
 * asserts the hook actually fired, so anchor drift reports itself instead of
 * surfacing as a confusing assertion diff (PR #3221 review).
 */
export function answerLeafInGrantWindow(
  database: PGlite,
  card: { readonly delegation?: { readonly toolCallId: string }; readonly toolCallId: string }
): () => void {
  type Query = PGlite['query'];
  const original: Query = database.query.bind(database);
  let fired = false;
  const restore = () => {
    Reflect.deleteProperty(database, 'query');
  };
  database.query = (async (...args: Parameters<Query>) => {
    try {
      const result = await original(...args);
      if (typeof args[0] === 'string' && args[0].includes('unanswerable AS (')) {
        fired = true;
        restore();
        await answerLeafConcurrently(database, card);
      }
      return result;
    } catch (error) {
      restore();
      throw error;
    }
  }) as Query;
  return () => {
    restore();
    expect(fired, "the grant's discovery read never ran, so nothing raced it").toBe(true);
  };
}

export async function decisionRows(
  database: PGlite
): Promise<readonly { parent_tool_call_id: string; state: string }[]> {
  return (
    await database.query<{ parent_tool_call_id: string; state: string }>(
      'SELECT parent_tool_call_id, state FROM brainstrike_delegated_tool_decisions ORDER BY parent_tool_call_id'
    )
  ).rows;
}

export async function decisionRowIds(
  database: PGlite,
  parentToolCallId: string
): Promise<string[]> {
  return (
    await database.query<{ id: string }>(
      'SELECT id FROM brainstrike_delegated_tool_decisions WHERE parent_tool_call_id = $1 ORDER BY id',
      [parentToolCallId]
    )
  ).rows.map((row) => row.id);
}
