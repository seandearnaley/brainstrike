import type { PermissionToolGateSnapshot, ToolRiskCategory } from '@brainstrike/assistant-contract';
import type { ModelMessage, Tool } from 'ai';
import { recordRawToolInputs } from './approval-input.js';
import { canonical, type Json, jsonValue } from './json-value.js';
import type { HostMcpInputPersistenceError } from './mcp-input-state.js';
import type { HostClientOrigin, HostRunAdmission, HostRunContext, HostRunOwner } from './ports.js';
import {
  HOST_METHOD_SCHEMAS,
  type HostChildDelivery,
  type HostChildOrigin,
  type HostEvent,
  type HostImageAttachment,
  type HostParams,
  type HostPermissionGrant,
  HostPromptBreakdownSchema,
  type HostRunSnapshot,
} from './protocol.js';

/** HostCore alone folds and writes accepted command records. */
export interface AcceptedCommand {
  readonly method: string;
  readonly payload: string;
  readonly result: Json;
  readonly threadId: string;
}

/** Process-local attempts retain uncertainty; restart uses only committed records. */
export interface AttemptedCommand {
  readonly method: string;
  readonly payload: string;
  readonly settlement: Promise<Json>;
  readonly threadId?: string;
}

/** Owned exclusively by HostCore, with no independent writer or admission queue. */
export class HostCommandLedger {
  private readonly accepted = new Map<string, AcceptedCommand>();
  private readonly attempts = new Map<string, AttemptedCommand>();

  commit(commandId: string, command: AcceptedCommand): void {
    this.accepted.set(commandId, command);
    const attempt = this.attempts.get(commandId);
    if (attempt) {
      this.attempts.set(commandId, { ...attempt, threadId: command.threadId });
    }
  }

  /** Erase process-local payloads only after their canonical thread deletion joined. */
  forgetThread(threadId: string): readonly string[] {
    const conversationCommands: string[] = [];
    for (const [id, command] of this.accepted) {
      if (command.threadId === threadId) {
        if (command.method === 'run/start' || command.method === 'run/regenerate') {
          conversationCommands.push(id);
        }
        this.accepted.delete(id);
      }
    }
    for (const [id, command] of this.attempts) {
      if (command.threadId === threadId) {
        this.attempts.delete(id);
      }
    }
    return conversationCommands;
  }

  async perform<T extends Json>(
    method: string,
    params: { commandId: string; threadId?: string },
    perform: () => Promise<T>,
    repeat?: (result: T) => Promise<T>
  ): Promise<T> {
    const payload = canonical(jsonValue(params));
    const attempt = this.attempts.get(params.commandId);
    const previous = attempt ?? this.accepted.get(params.commandId);
    if (previous && (previous.method !== method || previous.payload !== payload)) {
      throw new Error('Command identity was reused with different input');
    }
    if (attempt) {
      // Includes physical joining and preserves rejection after a genuine commit.
      return (await attempt.settlement) as T;
    }
    const committed = this.accepted.get(params.commandId);
    if (committed) {
      return repeat ? repeat(committed.result as T) : (committed.result as T);
    }
    const settlement = Promise.withResolvers<Json>();
    settlement.promise.catch(() => undefined);
    this.attempts.set(params.commandId, {
      method,
      payload,
      settlement: settlement.promise,
      ...(params.threadId ? { threadId: params.threadId } : {}),
    });
    try {
      const value = await perform();
      settlement.resolve(value);
      return value;
    } catch (cause) {
      settlement.reject(cause);
      throw cause;
    }
  }
}

type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Interaction = Extract<HostEvent, { type: 'interaction.requested' }>;
export interface PendingInteraction {
  decision?: 'approve' | 'deny';
  readonly event: Interaction;
  resumeData?: Json;
  runtimeInput?: { readonly value: unknown };
}

export function hasHostInteractionResponse(pending: PendingInteraction): boolean {
  return pending.event.kind === 'approval'
    ? pending.decision !== undefined
    : Object.hasOwn(pending, 'resumeData');
}

/** What a run was started with that its plan's follow-up run starts with again. */
export interface HostRunInput {
  readonly configuration?: HostParams<'run/start'>['configuration'];
  readonly origin?: HostClientOrigin;
}

/**
 * A thread's grants, kept by Core for its process lifetime. Only live
 * acceptance adds to them; replay after a restart never restores a grant.
 */
export interface HostThreadGrants {
  readonly categories: Set<ToolRiskCategory>;
  readonly tools: Set<string>;
}

export function applyHostPermissionGrant(run: HostRunState, grant: HostPermissionGrant): void {
  if (grant.scope === 'session') {
    run.grants.categories.add(grant.category);
  } else {
    run.grants.tools.add(grant.toolId);
  }
}

/** Folds a committed interaction request or response into its run's pending set. */
export function foldHostInteraction(
  runs: ReadonlyMap<string, HostRunState>,
  event: Extract<HostEvent, { type: 'interaction.requested' | 'interaction.responded' }>
): void {
  const run = runs.get(event.runId);
  if (event.type === 'interaction.requested') {
    if (!run) {
      throw new Error('Interaction references an unknown run');
    }
    const runtimeInput = run.liveInputs.get(event.toolCallId);
    run.approvals.set(event.interactionId, { event, ...(runtimeInput ? { runtimeInput } : {}) });
    run.paused = true;
    return;
  }
  const approval = run?.approvals.get(event.interactionId);
  if (!approval) {
    return;
  }
  if ('decision' in event) {
    approval.decision = event.decision;
  } else {
    approval.resumeData = event.resumeData;
  }
}
/** Folds a committed effect or terminal into its run; other events are not run effects. */
export function foldHostRunEffect(
  runs: ReadonlyMap<string, HostRunState>,
  event: HostEvent,
  ts: number | undefined
): void {
  if (event.type === 'effect.started') {
    const run = runs.get(event.runId);
    run?.started.add(event.toolCallId);
    run?.effectTools.set(event.toolCallId, event.toolCatalogId ?? event.toolId);
  } else if (event.type === 'effect.finished') {
    const run = runs.get(event.runId);
    run?.outputs.set(event.toolCallId, event.output);
    if (ts !== undefined) {
      run?.outputCommittedAt.set(event.toolCallId, ts);
    }
  } else if (event.type === 'run.finished') {
    const run = runs.get(event.runId);
    if (run) {
      run.terminal = true;
      run.outcome = event.outcome;
      // BST-1932: a child's failure reaches its parent with its committed reason.
      if (event.detail !== undefined) {
        run.detail = event.detail;
      }
    }
  }
}

/** A run's committed position in the thread's conversation tree. */
export interface HostRunBranch {
  /** Images on the user message, beside its prompt. */
  readonly attachments?: readonly HostImageAttachment[];
  /** BST-1932: background child results delivered with this run's user message. */
  readonly delivery?: HostChildDelivery;
  /** The committed run its user message follows; null is the thread root. */
  readonly parentMessageId: string | null;
  readonly prompt: string;
  /** The run/start command that committed the user message (a regeneration reuses it). */
  readonly userMessageId: string;
}

export interface HostRunState {
  admission?: HostRunAdmission;
  admissionTask?: Promise<HostRunAdmission>;
  /** A child's root permission policy at admission; only its denies stay frozen (ADR-0010). */
  admittedPolicy?: PermissionToolGateSnapshot;
  readonly approvals: Map<string, PendingInteraction>;
  readonly branch: HostRunBranch;
  readonly checkpointedResults: Set<string>;
  completion?: Promise<void>;
  /** Calls awaiting network consent this step, and whether the policy also asked to approve them. */
  readonly consents: Map<string, { readonly approval: boolean }>;
  readonly controller: AbortController;
  /** Set when a child's execution deadline expired; it ends failed, not stopped. */
  deadline?: string;
  /** The committed run.finished detail, once terminal. */
  detail?: string;
  readonly effects: Set<Promise<unknown>>;
  /** The tool each committed effect ran, by call: catalog id, else provider name. */
  readonly effectTools: Map<string, string>;
  /** Its thread's grants for this host process, shared with the thread's other runs. */
  readonly grants: HostThreadGrants;
  readonly id: string;
  /**
   * The input its thread's next run repeats when this plan-mode run's plan is
   * approved: the admitting configuration, and the live client's origin.
   */
  input?: HostRunInput;
  readonly liveInputs: Map<string, { readonly value: unknown }>;
  mcpInputPersistenceFailures?: HostMcpInputPersistenceError[];
  /** Positions of this run's own messages in its selected-path context. */
  readonly messageIndexes: Set<number>;
  /** This run's own committed model messages, after its user message. */
  readonly messages: ModelMessage[];
  readonly modelId: string;
  /**
   * The provider's web search standing in for the catalog tool, fixed when the
   * run was admitted: only when that tool resolved to `allow` and no approval
   * of it is in flight. It has no execute, so steps re-check the live policy.
   */
  nativeWebSearch?: { readonly tool: Tool; readonly toolId: string } | undefined;
  /** BST-1932: present on every run of a child thread. */
  origin?: HostChildOrigin;
  outcome?: Extract<HostEvent, { type: 'run.finished' }>['outcome'];
  /** When each output committed (its row time), for artifact retention. */
  readonly outputCommittedAt: Map<string, number>;
  readonly outputs: Map<string, Json>;
  owner?: Promise<HostRunOwner | undefined>;
  ownerClose?: Promise<void>;
  /** The owner joined all of its work, but some failed: this run's failed outcome. */
  ownerFailure?: unknown;
  paused: boolean;
  readonly permits: Map<string, Action>;
  /** Committed on run.started: it reads and proposes a plan, and approval ends it. */
  planMode?: true;
  /** A child's root thread, whose live permission policy governs its decisions. */
  policyThreadId?: string;
  readonly rawInputs: Map<string, Json>;
  release?: (() => void) | undefined;
  readonly responses: Set<string>;
  readonly snapshot?: HostRunSnapshot;
  readonly started: Set<string>;
  /** A committed run/steer: the run ends after its step in flight. */
  steered: boolean;
  steps: number;
  stopAcceptance?: Promise<void> | undefined;
  stopped: boolean;
  task?: Promise<void>;
  terminal: boolean;
  readonly threadId: string;
  /** A follow-up typed into an idle child starts its own turn: its ID. */
  turnId?: string;
}

export function createHostRunState(
  threadId: string,
  id: string,
  modelId: string,
  branch: HostRunBranch,
  grants: HostThreadGrants,
  snapshot?: HostRunSnapshot,
  controller = new AbortController()
): HostRunState {
  return {
    approvals: new Map(),
    branch,
    checkpointedResults: new Set(),
    consents: new Map(),
    controller,
    effects: new Set(),
    grants,
    id,
    liveInputs: new Map(),
    messageIndexes: new Set(),
    messages: [],
    modelId,
    ...(snapshot ? { snapshot } : {}),
    effectTools: new Map(),
    outputCommittedAt: new Map(),
    outputs: new Map(),
    paused: false,
    permits: new Map(),
    rawInputs: new Map(),
    responses: new Set(),
    started: new Set(),
    steered: false,
    steps: 0,
    stopped: false,
    terminal: false,
    threadId,
  };
}

export function foldHostAcceptedCommand(
  commands: HostCommandLedger,
  runs: ReadonlyMap<string, HostRunState>,
  event: Extract<HostEvent, { type: 'command.accepted' }>,
  threadId: string
): void {
  commands.commit(event.commandId, {
    method: event.method,
    payload: canonical(event.payload),
    result: event.result,
    threadId,
  });
  if (event.method !== 'run/stop' && event.method !== 'run/steer') {
    return;
  }
  const params = HOST_METHOD_SCHEMAS[event.method].parse(event.payload);
  const run = runs.get(params.runId);
  if (!run) {
    return;
  }
  if (event.method === 'run/stop') {
    run.stopped = true;
  } else {
    run.steered = true;
  }
}

/** HostCore supplies already-validated committed messages; no independent fold or writer. */
export function foldHostRunMessages(
  run: HostRunState,
  event: Extract<HostEvent, { type: 'model.step' | 'model.messages' }>,
  messages: readonly ModelMessage[],
  previousLength: number
): void {
  for (let index = 0; index < messages.length; index += 1) {
    run.messageIndexes.add(previousLength + index);
  }
  if (event.type === 'model.step') {
    run.steps = event.stepNumber + 1;
  }
  recordRawToolInputs(run.rawInputs, messages);
  for (const message of messages) {
    if (message.role !== 'tool') {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'tool-approval-response') {
        run.responses.add(part.approvalId);
      }
      if (part.type === 'tool-result') {
        run.checkpointedResults.add(part.toolCallId);
      }
    }
  }
}

/** Receipts use the caller's existing FULL publisher, with no queue/store of their own. */
export function createHostRunContext(
  run: HostRunState,
  publish: (threadId: string, events: readonly HostEvent[]) => Promise<unknown>
): HostRunContext {
  return {
    recordObservationWithheld: async (reason) => {
      await publish(run.threadId, [{ reason, runId: run.id, type: 'memory.observation.withheld' }]);
    },
    recordObserverUsage: async (receipt) => {
      if (run.terminal) {
        throw new Error('Memory receipt arrived after the run lifetime joined');
      }
      await publish(run.threadId, [
        {
          kind: receipt.kind,
          modelId: receipt.modelId,
          runId: run.id,
          type: 'memory.usage',
          usage: jsonValue(receipt.usage),
        },
      ]);
    },
    recordProviderRequest: async (receipt) => {
      if (run.terminal) {
        throw new Error('Provider receipt arrived after the run lifetime joined');
      }
      await publish(run.threadId, [
        {
          accounting: jsonValue(receipt.accounting),
          breakdown: HostPromptBreakdownSchema.parse(receipt.breakdown),
          modelId: receipt.modelId,
          provider: receipt.provider,
          runId: run.id,
          type: 'provider.request.prepared',
        },
      ]);
    },
    runId: run.id,
    signal: run.controller.signal,
    threadId: run.threadId,
  };
}

/** The workspace read is a clone of the existing host-owned committed projection. */
export function readHostWorkspaceSnapshot(
  threads: ReadonlySet<string>,
  workspaces: ReadonlyMap<string, HostParams<'thread/workspace/set'>['snapshot']>,
  threadId: string
): { snapshot: HostParams<'thread/workspace/set'>['snapshot'] | null } {
  if (!threads.has(threadId)) {
    throw new Error('Unknown thread');
  }
  return { snapshot: structuredClone(workspaces.get(threadId) ?? null) };
}

/** Prepare validated data; HostCore supplies its sole command acceptance writer. */
export async function acceptHostWorkspaceSnapshot(
  params: HostParams<'thread/workspace/set'>,
  threads: ReadonlySet<string>,
  accept: (event: Extract<HostEvent, { type: 'workspace.updated' }>) => Promise<void>
): Promise<{ accepted: true }> {
  if (!threads.has(params.threadId)) {
    throw new Error('Unknown thread');
  }
  await accept({ snapshot: structuredClone(params.snapshot), type: 'workspace.updated' });
  return { accepted: true };
}

/** Existing conversation collision invariant, folded into HostCore's supplied set. */
export function recordHostConversationId(ids: Set<string>, id: string): void {
  if (ids.has(id)) {
    throw new Error('Committed conversation identities collide');
  }
  ids.add(id);
}
