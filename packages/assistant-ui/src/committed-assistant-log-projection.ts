import {
  type ExportedMessageRepository,
  fromThreadMessageLike,
  type ThreadAssistantMessage,
  type ThreadMessage,
} from '@assistant-ui/react';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  type AssistantRunEvent,
  describeRunAttempt,
  PROVIDER_CALL_WARNING_RUN_EVENT_KIND,
  providerCallWarningDetail,
  providerCallWarningLabel,
  providerCallWarningMetadata,
  readProviderCallWarning,
} from '@brainstrike/assistant-contract';
import {
  type AssistantContextBreakdownState,
  parseAssistantContextBreakdown,
} from '@brainstrike/assistant-contract/context-breakdown';
import {
  createDeclinedToolCallResult,
  isApprovalTargetRoot,
  isCodeExecutionApprovalContext,
  TOOL_CALL_BLOCKED_MESSAGE,
  TOOL_CALL_DECLINED_MESSAGE,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  isToolRiskCategory,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';
import { parsePartialJsonObject } from 'assistant-stream/utils';
import { activityTraceShowsEnd } from './assistant-activity-grouping';
import { committedApprovalOptions } from './committed-approval-options';
import { committedFileNotices } from './committed-file-notices';
import {
  committedAttachments,
  committedStreamData,
  HOST_EVENT_DATA_NAME,
  HOST_STREAM_DATA_NAME,
  mcpToolsUnavailableNotice,
  readRunAttempt,
  record,
  requiredString,
  worktreeCreatedNotice,
} from './committed-host-event-readers';
import { CommittedRewindHead, type CommittedRewindHeadMove } from './committed-rewind-head';
import {
  committedStepParts,
  liveOverlayEntry,
  MODEL_STREAM_TYPES,
  mergeProviderMetadata,
  providerMetadata,
  withIndexedPart,
  withoutIndexedPart,
} from './committed-step-text';
import { HOST_CONTEXT_COMPACTED_DATA_NAME } from './compaction-summary-message';
import type { ThreadTokenUsage } from './context-usage-store';

/** Structural consumer boundary for the owner's validated HostLogRow, not a wire schema. */
export interface CommittedAssistantLogRow {
  readonly event: Readonly<Record<string, unknown>>;
  readonly seq: number;
  readonly threadId: string;
  /** The row's committed time, when the owner supplies it. */
  readonly ts?: number;
}

/** IDs, parents and timestamps come from the owner; the projection never creates durable IDs. */
export interface CommittedAssistantRunIdentity {
  readonly assistantMessageId: string;
  readonly createdAt: Date;
  readonly metadata?: ThreadMessage['metadata'];
  readonly parentMessageId: string | null;
  readonly userMessageId?: string;
}

export interface CommittedAssistantLogProjectionOptions {
  readonly baseline?: ExportedMessageRepository;
  readonly identifyRun: (row: CommittedAssistantLogRow) => CommittedAssistantRunIdentity;
  readonly threadId: string;
}

/** What a committed interaction asks of a person. */
export type CommittedInteractionKind = 'approval' | 'question' | 'plan' | 'network';

export interface CommittedAssistantPendingInteraction {
  readonly interactionId: string;
  readonly kind?: CommittedInteractionKind;
  /** The tool a per-tool grant names: its catalog ID, else its recorded ID. */
  readonly permissionToolId: string;
  /** A permission approval's risk category, which its session grant names. */
  readonly risk?: ToolRiskCategory;
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly toolIdentity: string;
}

export interface CommittedAssistantLogView {
  readonly activeRunId: string | undefined;
  /** Latest prepared provider prompt's composition, for the context popover. */
  readonly contextBreakdown?: AssistantContextBreakdownState | undefined;
  /** Latest chat provider step, never aggregate billing or observer usage. */
  readonly contextUsage?: ThreadTokenUsage | undefined;
  readonly isRunning: boolean;
  /** The latest run received no observational memory, and why. */
  readonly observationWithheld?: 'branched-thread' | undefined;
  readonly pendingInteractions: readonly CommittedAssistantPendingInteraction[];
  readonly repository: ExportedMessageRepository;
}

type Part = ThreadAssistantMessage['content'][number];
type ToolPart = Extract<Part, { type: 'tool-call' }>;
type MessageStatus = ThreadAssistantMessage['status'];

const RUNNING: MessageStatus = { type: 'running' };
/**
 * The installed vendor's own reading of an unanswered approval
 * (`getAutoStatus`: `isInterruptedToolCall` → `requires-action`/`interrupt`).
 * Its `toMessagePartStatus` hands this status to every resultless tool part,
 * which the shared cards read as `Waiting for approval`.
 */
const AWAITING_INTERACTION: MessageStatus = { reason: 'interrupt', type: 'requires-action' };
interface ProjectedRun {
  readonly authoritativeInputs: Set<string>;
  readonly authoritativeResults: Set<string>;
  readonly createdAt: Date;
  /** A refused call's reason, from its approval response, until its denial settles it. */
  readonly denialReasons: Map<string, string>;
  readonly messageId: string;
  /** Keys of the open step's live text and reasoning overlay parts. */
  readonly overlay: Set<string>;
  readonly partIndexes: Map<string, number>;
  readonly runId: string;
  /** The commit time of the run's `run.started`, when the row carries one. */
  readonly startedAt: number | undefined;
  step: number;
  /** A step started and neither its `model.step` nor a Stop's partial committed yet. */
  stepOpen: boolean;
  terminal: boolean;
  /** Distinct provider warnings shown for this run: one fact, one row. */
  readonly warnings: Set<string>;
}

type ProjectedRunEvent = Pick<
  AssistantRunEvent,
  'detail' | 'durationMs' | 'kind' | 'label' | 'metadata' | 'status'
>;

function toolOwnership(
  prior: ToolPart | undefined,
  input: Readonly<Record<string, unknown>>,
  authoritative: boolean,
  retainInput: boolean
): NonNullable<ToolPart['providerMetadata']>[string] | undefined {
  if (authoritative && typeof input['toolIdentity'] === 'string') {
    return {
      toolIdentity: input['toolIdentity'],
      ...(typeof input['toolId'] === 'string' ? { toolId: input['toolId'] } : {}),
    };
  }
  return retainInput
    ? Object.fromEntries(
        Object.entries(prior?.providerMetadata?.['brainstrike'] ?? {}).filter(
          ([key]) => key === 'toolIdentity' || key === 'toolId'
        )
      )
    : undefined;
}

function projectToolPart(
  prior: ToolPart | undefined,
  input: Readonly<Record<string, unknown>>,
  id: string,
  authoritative: boolean,
  retainInput: boolean
): ToolPart {
  // The user-facing catalog ID when the host committed one; older rows keep
  // the provider-facing name they actually carry.
  const name = [input['toolCatalogId'], input['toolId'], input['toolName']].find(
    (value) => typeof value === 'string'
  );
  if (typeof name !== 'string' && !prior) {
    throw new Error('Committed tool call has no tool name.');
  }
  const argsText =
    retainInput || input['input'] === undefined
      ? (prior?.argsText ?? '')
      : JSON.stringify(input['input']);
  const metadata = mergeProviderMetadata(
    prior?.providerMetadata,
    providerMetadata(input['providerMetadata']),
    toolOwnership(prior, input, authoritative, retainInput)
  );
  const toolName = retainInput
    ? (prior?.toolName ?? '')
    : typeof name === 'string'
      ? name
      : (prior?.toolName ?? '');
  if (
    prior &&
    prior.providerMetadata === metadata &&
    prior.argsText === argsText &&
    prior.toolName === toolName
  ) {
    return prior;
  }
  return {
    ...prior,
    args: argsText === prior?.argsText ? prior.args : (parsePartialJsonObject(argsText) ?? {}),
    argsText,
    ...(metadata ? { providerMetadata: metadata } : {}),
    toolCallId: id,
    toolName,
    type: 'tool-call',
  };
}

/** The ID a permission names a tool by: its catalog ID, else its recorded tool ID. */
function committedToolCatalogId(event: Readonly<Record<string, unknown>>): string {
  return typeof event['toolCatalogId'] === 'string'
    ? event['toolCatalogId']
    : requiredString(event, 'toolId');
}

/**
 * What the card reads beside the approval: a question or plan's kind, or an
 * approval's host facts (a code-execution context, or the folder a file call
 * targets; each validated before use). A network consent carries both: its
 * kind, and the facts when they are valid.
 */
function interactionFacts(
  kind: CommittedInteractionKind,
  executionContext: unknown,
  targetRoot: unknown
): NonNullable<ToolPart['providerMetadata']>[string] | undefined {
  if (kind === 'network') {
    const facts: Readonly<Record<string, unknown>> = {
      interactionKind: kind,
      ...(isCodeExecutionApprovalContext(executionContext) ? { executionContext } : {}),
    };
    return facts as NonNullable<ToolPart['providerMetadata']>[string];
  }
  if (kind !== 'approval') {
    return { interactionKind: kind };
  }
  // A shape this build does not fully understand falls to the card's
  // absent-context path (no fact rows, no grants), never a partial render.
  // The owner has already validated JSON at the public HostLogRow boundary.
  const context = isCodeExecutionApprovalContext(executionContext);
  const target = isApprovalTargetRoot(targetRoot);
  if (!(context || target)) {
    return;
  }
  const facts: Readonly<Record<string, unknown>> = {
    ...(context ? { executionContext } : {}),
    ...(target ? { targetRoot } : {}),
  };
  return facts as NonNullable<ToolPart['providerMetadata']>[string];
}

/**
 * A permission approval answers with its grant options; a question or plan with
 * text. A network consent answers with text (`{ action }`), and with the
 * approval's grant options only where it also stands in for an approval.
 */
function interactionAnswers(
  kind: CommittedInteractionKind,
  risk: ToolRiskCategory | undefined
): Pick<NonNullable<ToolPart['approval']>, 'allowFreeform' | 'display' | 'options'> {
  if (kind === 'network') {
    return { allowFreeform: true, ...(risk ? { options: committedApprovalOptions(risk) } : {}) };
  }
  if (kind !== 'approval') {
    return { allowFreeform: true, display: 'text' };
  }
  return risk ? { options: committedApprovalOptions(risk) } : {};
}

/** A refusal's reason rides its approval response; the denial chunk that follows has none. */
function recordDenialReason(run: ProjectedRun, chunk: Readonly<Record<string, unknown>>): void {
  const call = record(chunk['toolCall']);
  if (chunk['approved'] === false && call && typeof chunk['reason'] === 'string') {
    run.denialReasons.set(requiredString(call, 'toolCallId'), chunk['reason']);
  }
}

/** Whether a committed response let its call run: approve, allow, or any answer. */
function committedInteractionApproved(
  kind: CommittedInteractionKind | undefined,
  event: Readonly<Record<string, unknown>>
): boolean {
  if (kind === 'network') {
    return record(event['resumeData'])?.['action'] === 'allow';
  }
  return kind !== 'approval' || event['decision'] === 'approve';
}

function incompleteReason(outcome: unknown): 'cancelled' | 'error' | 'other' {
  return outcome === 'stopped' ? 'cancelled' : outcome === 'failed' ? 'error' : 'other';
}

/**
 * Read-only rich presentation projection AFTER the existing owner's contiguous
 * committed fold. No gap buffer, log append, transport or command admission.
 * An incremental cursor changes only affected messages/parts. A fresh instance
 * over the same prefix and owner identities produces the same exported view.
 */
export class CommittedAssistantLogProjection {
  private cursor = 0;
  private readonly runs = new Map<string, ProjectedRun>();
  private readonly messageIndexes = new Map<string, number>();
  private readonly rewinds = new CommittedRewindHead();
  private view: CommittedAssistantLogView;

  constructor(private readonly options: CommittedAssistantLogProjectionOptions) {
    const repository = options.baseline ?? { headId: null, messages: [] };
    repository.messages.forEach(({ message }, index) => {
      this.messageIndexes.set(message.id, index);
    });
    this.view = { activeRunId: undefined, isRunning: false, pendingInteractions: [], repository };
  }

  readonly getSnapshot = (): CommittedAssistantLogView => this.view;

  acceptCommitted(rows: readonly CommittedAssistantLogRow[]): CommittedAssistantLogView {
    for (const row of rows) {
      if (row.threadId !== this.options.threadId || row.seq <= this.cursor) {
        continue;
      }
      if (row.seq !== this.cursor + 1) {
        throw new Error('Rich projection requires the owner’s contiguous committed prefix.');
      }
      this.apply(row);
      this.cursor = row.seq;
    }
    return this.view;
  }

  private message(run: ProjectedRun): ThreadAssistantMessage {
    const index = this.messageIndexes.get(run.messageId);
    const message = index === undefined ? undefined : this.view.repository.messages[index]?.message;
    if (message?.role !== 'assistant') {
      throw new Error('Committed assistant identity has no assistant message.');
    }
    return message;
  }

  private put(message: ThreadMessage, parentId?: string | null): void {
    const previousIndex = this.messageIndexes.get(message.id);
    const messages = [...this.view.repository.messages];
    if (previousIndex === undefined) {
      this.messageIndexes.set(message.id, messages.length);
      messages.push({ message, parentId: parentId ?? null });
    } else {
      const previous = messages[previousIndex];
      if (!previous) {
        throw new Error('Committed message index has no repository row.');
      }
      messages[previousIndex] = { ...previous, message };
    }
    this.view = { ...this.view, repository: { ...this.view.repository, messages } };
  }

  /** Write the keyed part; an update that returns undefined has nothing to show yet. */
  private part(
    run: ProjectedRun,
    key: string,
    update: (previous?: Part) => Part | undefined
  ): void {
    const message = this.message(run);
    const index = run.partIndexes.get(key) ?? message.content.length;
    const previous = message.content[index];
    const next = update(previous);
    if (next === undefined || next === previous) {
      return;
    }
    const content = [...message.content];
    content[index] = next;
    run.partIndexes.set(key, index);
    this.put({ ...message, content });
  }

  private data(
    run: ProjectedRun,
    row: CommittedAssistantLogRow,
    data: unknown,
    name: string
  ): void {
    this.part(run, `data:${row.seq}`, () => ({ data, name, type: 'data' }));
  }

  /** A run-timeline row derived from one committed host row; its identity is the row's. */
  private runEvent(
    run: ProjectedRun,
    row: CommittedAssistantLogRow,
    key: string,
    event: ProjectedRunEvent
  ): void {
    const data: AssistantRunEvent = {
      ...event,
      id: `${run.runId}:${row.seq}:${key}`,
      runId: run.runId,
      // A row without its committed time sits at its run's creation.
      timestamp: new Date(row.ts ?? run.createdAt.getTime()).toISOString(),
    };
    this.part(run, `run-event:${row.seq}:${key}`, () => ({
      data,
      name: ASSISTANT_RUN_EVENT_DATA_NAME,
      type: 'data',
    }));
  }

  /** The provider's report of what it did not do with this request (BST-1701). */
  private warned(run: ProjectedRun, row: CommittedAssistantLogRow, warnings: unknown): void {
    if (!Array.isArray(warnings)) {
      return;
    }
    warnings.forEach((entry: unknown, index) => {
      const warning = readProviderCallWarning(entry);
      const signature = JSON.stringify([warning.type, warning.subject, warning.detail]);
      if (run.warnings.has(signature)) {
        return;
      }
      run.warnings.add(signature);
      this.runEvent(run, row, `warning:${index}`, {
        detail: providerCallWarningDetail(warning),
        kind: PROVIDER_CALL_WARNING_RUN_EVENT_KIND,
        label: providerCallWarningLabel(warning),
        metadata: providerCallWarningMetadata(warning),
        status: 'failed',
      });
    });
  }

  /**
   * One provider attempt ended. Its unfinished text never entered the
   * transcript, so it reads as incomplete; the attempt and any re-attempt
   * are timeline rows with the legacy `run.stalled` / `run.resumed` kinds.
   */
  private attempt(run: ProjectedRun, row: CommittedAssistantLogRow): void {
    const attempt = readRunAttempt(row.event);
    const message = this.message(run);
    const content = message.content.map(
      (part): Part =>
        (part.type === 'text' || part.type === 'reasoning') && part.status?.type === 'running'
          ? { ...part, status: { reason: 'other', type: 'incomplete' } }
          : part
    );
    if (content.some((part, index) => part !== message.content[index])) {
      this.put({ ...message, content });
    }
    const notice = describeRunAttempt(attempt);
    const stall = record(row.event['stall']);
    this.runEvent(run, row, 'ended', {
      detail: notice.ended.detail,
      kind: 'run.stalled',
      label: notice.ended.label,
      metadata: {
        attempt: attempt.attempt,
        maxAttempts: attempt.maxAttempts,
        reason: attempt.reason,
        ...(attempt.refusal ? { refusal: attempt.refusal } : {}),
        ...(typeof stall?.['phase'] === 'string' ? { phase: stall['phase'] } : {}),
      },
      status: 'info',
    });
    if (notice.resumed) {
      this.runEvent(run, row, 'resumed', {
        detail: notice.resumed.detail,
        kind: 'run.resumed',
        label: notice.resumed.label,
        metadata: { attempt: attempt.attempt + 1, maxAttempts: attempt.maxAttempts },
        status: 'info',
      });
    }
  }

  private tool(
    run: ProjectedRun,
    input: Readonly<Record<string, unknown>>,
    authoritative = false
  ): string {
    const id = requiredString(input, 'toolCallId');
    this.part(run, `tool:${id}`, (previous) =>
      projectToolPart(
        previous?.type === 'tool-call' ? previous : undefined,
        input,
        id,
        authoritative,
        !authoritative && run.authoritativeInputs.has(id)
      )
    );
    if (authoritative) {
      run.authoritativeInputs.add(id);
    }
    return id;
  }

  /** A live run waits on the user exactly while it holds a pending host interaction. */
  private publishRunStatus(run: ProjectedRun, runId: string): void {
    if (run.terminal) {
      return;
    }
    const status = this.view.pendingInteractions.some((item) => item.runId === runId)
      ? AWAITING_INTERACTION
      : RUNNING;
    const message = this.message(run);
    if (message.status.type !== status.type) {
      this.put({ ...message, status });
    }
  }

  private updateTool(run: ProjectedRun, id: string, update: (part: ToolPart) => ToolPart): void {
    this.part(run, `tool:${id}`, (part) => {
      if (part?.type !== 'tool-call') {
        throw new Error('Committed tool result/decision has no matching call.');
      }
      return update(part);
    });
  }

  /**
   * The SDK settles a refused call with `tool-output-denied`. A call that held a
   * host interaction was the user's decline; any other was refused by the host
   * (a policy deny or a PreToolUse hook) before it could run.
   */
  private settleDenied(run: ProjectedRun, id: string): void {
    if (run.authoritativeResults.has(id)) {
      return;
    }
    const reason = run.denialReasons.get(id);
    this.updateTool(run, id, (part) => ({
      ...part,
      isError: false,
      result: createDeclinedToolCallResult(
        reason,
        part.approval ? TOOL_CALL_DECLINED_MESSAGE : TOOL_CALL_BLOCKED_MESSAGE
      ),
    }));
  }

  private start(row: CommittedAssistantLogRow): void {
    const runId = requiredString(row.event, 'runId');
    if (this.runs.has(runId)) {
      throw new Error('Committed run identity started twice.');
    }
    const identity = this.options.identifyRun(row);
    if (!(identity.assistantMessageId && Number.isFinite(identity.createdAt.getTime()))) {
      throw new Error('The owner must supply a canonical message identity and timestamp.');
    }
    let parentId = identity.parentMessageId;
    if (identity.userMessageId && this.messageIndexes.has(identity.userMessageId)) {
      // A regeneration answers its committed user message again: the new
      // answer is a sibling under it, and the user message stays as committed.
      parentId = identity.userMessageId;
    } else if (identity.userMessageId) {
      const attachments = committedAttachments(row.event, identity.userMessageId);
      // An image sent without text commits an empty prompt beside its images.
      const prompt = row.event['prompt'];
      if (typeof prompt !== 'string' || !(prompt || attachments?.length)) {
        throw new Error('Committed host event is missing prompt.');
      }
      const user = fromThreadMessageLike(
        {
          ...(attachments ? { attachments } : {}),
          content: prompt ? [{ text: prompt, type: 'text' }] : [],
          createdAt: identity.createdAt,
          id: identity.userMessageId,
          metadata: identity.metadata,
          role: 'user',
        },
        identity.userMessageId,
        { reason: 'stop', type: 'complete' }
      );
      this.put(user, parentId);
      parentId = user.id;
    }
    const message = fromThreadMessageLike(
      {
        content: [],
        createdAt: identity.createdAt,
        id: identity.assistantMessageId,
        metadata: identity.metadata,
        role: 'assistant',
        status: { type: 'running' },
      },
      identity.assistantMessageId,
      { type: 'running' }
    );
    this.put(message, parentId);
    this.runs.set(runId, {
      authoritativeInputs: new Set(),
      authoritativeResults: new Set(),
      createdAt: identity.createdAt,
      denialReasons: new Map(),
      messageId: message.id,
      overlay: new Set(),
      partIndexes: new Map(),
      runId,
      startedAt: row.ts,
      step: 0,
      stepOpen: false,
      terminal: false,
      warnings: new Set(),
    });
    this.view = {
      ...this.view,
      activeRunId: runId,
      isRunning: true,
      // A withheld reason belongs to the run that committed it.
      observationWithheld: undefined,
      repository: { ...this.view.repository, headId: message.id },
    };
  }

  /**
   * The open step's live text and reasoning, from uncommitted `run/telemetry`.
   * It shows while the step streams and is replaced by the step's committed
   * parts at its `model.step` (or a Stop's partial). Text is never folded from
   * deltas into the committed transcript (ADR-0011 amendment).
   */
  acceptLive(runId: string, chunk: unknown): CommittedAssistantLogView {
    const run = this.runs.get(runId);
    const entry = run?.stepOpen && !run.terminal ? liveOverlayEntry(run.step, chunk) : undefined;
    if (run && entry) {
      run.overlay.add(entry.key);
      this.part(run, entry.key, entry.part);
    }
    return this.view;
  }

  /**
   * The open step's committed text and reasoning, from its `model.step`
   * messages or a Stop's partial `model.messages`. The live overlay is dropped
   * here, never on the next `start-step`. Each committed part sits before the
   * tool call that follows it in its assistant message, so a reload keeps the
   * model's order.
   */
  private commitStepText(run: ProjectedRun, messages: unknown): void {
    run.stepOpen = false;
    for (const key of run.overlay) {
      this.removePart(run, key);
    }
    run.overlay.clear();
    committedStepParts(messages).forEach(({ anchor, part }, index) => {
      this.insertPart(run, JSON.stringify([run.step, part.type, index]), part, anchor);
    });
  }

  /** Remove one of the run's parts and close the gap in its part indexes. */
  private removePart(run: ProjectedRun, key: string): void {
    const message = this.message(run);
    const content = withoutIndexedPart(message.content, run.partIndexes, key);
    if (content) {
      this.put({ ...message, content: [...content] });
    }
  }

  /** Insert a part before an existing anchor part, or append it when the anchor is absent. */
  private insertPart(run: ProjectedRun, key: string, part: Part, anchor?: string): void {
    const message = this.message(run);
    this.put({
      ...message,
      content: [...withIndexedPart(message.content, run.partIndexes, key, part, anchor)],
    });
  }

  /**
   * A host event with no message part of its own: an attempt record becomes
   * its run's attempt notice, each skipped hook file a failed hook notice, a
   * compaction its compaction-card part, a withheld memory reason thread view
   * state, and anything else host-event data.
   */
  private other(run: ProjectedRun, row: CommittedAssistantLogRow): void {
    const event = row.event;
    if (event['type'] === 'mcp.tools.unavailable') {
      const notice = mcpToolsUnavailableNotice(
        event,
        row,
        requiredString(event, 'runId'),
        this.message(run).createdAt.toISOString()
      );
      this.data(run, row, notice, ASSISTANT_RUN_EVENT_DATA_NAME);
      return;
    }
    if (event['type'] === 'run.attempt') {
      this.attempt(run, row);
      return;
    }
    if (event['type'] === 'worktree.created') {
      const at = this.message(run).createdAt.toISOString();
      const notice = worktreeCreatedNotice(event, row, requiredString(event, 'runId'), at);
      this.data(run, row, notice, ASSISTANT_RUN_EVENT_DATA_NAME);
      return;
    }
    const fileNotices = committedFileNotices(event);
    if (fileNotices) {
      for (const { key, event: notice } of fileNotices) {
        this.runEvent(run, row, key, notice);
      }
      return;
    }
    if (event['type'] === 'context.compacted') {
      const kind = event['kind'];
      if (kind !== 'agentic' && kind !== 'deterministic') {
        throw new Error('Committed compaction has an unsupported kind.');
      }
      const summary = requiredString(event, 'summary');
      this.data(run, row, { kind, summary }, HOST_CONTEXT_COMPACTED_DATA_NAME);
      return;
    }
    if (event['type'] === 'provider.request.prepared' && event['breakdown'] !== undefined) {
      this.view = {
        ...this.view,
        contextBreakdown: parseAssistantContextBreakdown(event['breakdown']),
      };
    }
    if (event['type'] !== 'memory.observation.withheld') {
      this.data(run, row, event, HOST_EVENT_DATA_NAME);
      return;
    }
    if (event['reason'] !== 'branched-thread') {
      throw new Error('Committed withheld memory has an unsupported reason.');
    }
    this.view = { ...this.view, observationWithheld: event['reason'] };
  }

  private stream(run: ProjectedRun, row: CommittedAssistantLogRow): void {
    const chunk = record(row.event['chunk']);
    if (!chunk) {
      this.data(run, row, row.event['chunk'], HOST_STREAM_DATA_NAME);
      return;
    }
    const type = chunk['type'];
    const named = committedStreamData(chunk);
    if (named) {
      this.data(run, row, named.data, named.name);
      return;
    }
    if (type === 'tool-approval-response') {
      recordDenialReason(run, chunk);
    }
    if (type === 'start-step') {
      run.step += 1;
      run.stepOpen = true;
      this.warned(run, row, chunk['warnings']);
    } else if (typeof type === 'string' && MODEL_STREAM_TYPES.has(type)) {
      // A log written before text became telemetry: its `model.step` owns the text.
      return;
    } else if (type === 'tool-input-start') {
      this.tool(run, { ...chunk, toolCallId: chunk['id'] });
      return;
    } else if (type === 'tool-input-delta') {
      const id = requiredString(chunk, 'id');
      this.tool(run, { ...chunk, toolCallId: id });
      if (!run.authoritativeInputs.has(id)) {
        this.updateTool(run, id, (part) => {
          const argsText = part.argsText + requiredString(chunk, 'delta');
          return { ...part, args: parsePartialJsonObject(argsText) ?? {}, argsText };
        });
      }
      return;
    } else if (type === 'tool-input-end') {
      this.tool(run, { ...chunk, toolCallId: chunk['id'] });
      return;
    } else if (type === 'tool-call') {
      this.tool(run, chunk);
      return;
    } else if (type === 'tool-result' || type === 'tool-error') {
      const id = this.tool(run, chunk);
      if (!run.authoritativeResults.has(id)) {
        this.updateTool(run, id, (part) => ({
          ...part,
          isError: type === 'tool-error',
          result: type === 'tool-error' ? chunk['error'] : chunk['output'],
        }));
      }
      return;
    } else if (type === 'tool-output-denied') {
      this.settleDenied(run, requiredString(chunk, 'toolCallId'));
      return;
    }
    // SDK approval IDs are intentionally never native decision identities.
    // Preserve unhandled rich chunks and provider/child data verbatim.
    this.data(run, row, chunk, HOST_STREAM_DATA_NAME);
  }

  private finish(
    run: ProjectedRun,
    row: CommittedAssistantLogRow,
    event: Readonly<Record<string, unknown>>
  ): void {
    run.terminal = true;
    for (const interaction of this.view.pendingInteractions.filter(
      (item) => item.runId === event['runId']
    )) {
      this.updateTool(run, interaction.toolCallId, (part) => ({
        ...part,
        approval: {
          ...part.approval,
          id: interaction.interactionId,
          resolution: 'cancelled',
        },
      }));
    }
    const outcome = event['outcome'];
    const message = this.message(run);
    const content = message.content.map((part): Part => {
      if ((part.type !== 'text' && part.type !== 'reasoning') || part.status?.type !== 'running') {
        return part;
      }
      return {
        ...part,
        status:
          outcome === 'completed'
            ? { type: 'complete' }
            : {
                reason: incompleteReason(outcome),
                type: 'incomplete',
              },
      };
    });
    this.put({
      ...message,
      content,
      status:
        outcome === 'completed'
          ? { reason: 'stop', type: 'complete' }
          : {
              reason: incompleteReason(outcome),
              type: 'incomplete',
              ...(typeof event['detail'] === 'string' ? { error: event['detail'] } : {}),
            },
    });
    if (outcome === 'completed') {
      // The legacy stream's terminal event, once on the run's final leg: its
      // verdict and Changes review controls read the run from it.
      this.runEvent(run, row, 'finished', {
        kind: 'run.finished',
        label: 'Assistant run completed',
        status: 'completed',
      });
    }
    if (
      (outcome === 'stopped' || outcome === 'interrupted') &&
      !activityTraceShowsEnd(this.message(run).content)
    ) {
      // An early end gets exactly one marker. A call cut off mid-run carries it
      // in its activity trace ("Stopped after Ns"); otherwise, as for a reply
      // that streamed only text, the vendor shows nothing for the incomplete
      // status, so the committed end is this always-visible row (BST-1981,
      // BST-1982), with the host's reason when it gave one.
      this.runEvent(run, row, outcome, {
        ...(typeof event['detail'] === 'string' && outcome === 'interrupted'
          ? { detail: event['detail'] }
          : {}),
        // A Stop ends the run in this host session, so its committed times
        // give "Stopped after Ns"; a recovered interruption spans the downtime.
        ...(outcome === 'stopped' && row.ts !== undefined && run.startedAt !== undefined
          ? { durationMs: row.ts - run.startedAt }
          : {}),
        kind: 'run.cancelled',
        label: outcome === 'stopped' ? 'Stopped' : 'Reply interrupted',
        status: 'cancelled',
      });
    }
    const active = [...this.runs].findLast(([, candidate]) => !candidate.terminal)?.[0];
    this.view = {
      ...this.view,
      activeRunId: active,
      isRunning: active !== undefined,
      pendingInteractions: this.view.pendingInteractions.filter(
        (item) => item.runId !== event['runId']
      ),
    };
  }

  /** A committed interaction request becomes its tool's approval and a pending interaction. */
  private request(
    run: ProjectedRun,
    row: CommittedAssistantLogRow,
    event: Readonly<Record<string, unknown>>,
    runId: string
  ): void {
    const id = this.tool(run, event, true);
    const interactionId = requiredString(event, 'interactionId');
    const kind = event['kind'];
    if (kind !== 'approval' && kind !== 'question' && kind !== 'plan' && kind !== 'network') {
      throw new Error('Committed interaction has an unsupported kind.');
    }
    const risk = isToolRiskCategory(event['risk']) ? event['risk'] : undefined;
    const facts = interactionFacts(kind, event['executionContext'], event['targetRoot']);
    this.updateTool(run, id, (part) => ({
      ...part,
      approval: {
        id: interactionId,
        ...interactionAnswers(kind, risk),
      },
      ...(facts
        ? {
            providerMetadata: {
              ...part.providerMetadata,
              brainstrike: { ...part.providerMetadata?.['brainstrike'], ...facts },
            },
          }
        : {}),
    }));
    this.view = {
      ...this.view,
      pendingInteractions: [
        ...this.view.pendingInteractions,
        {
          interactionId,
          kind,
          permissionToolId: committedToolCatalogId(event),
          ...(risk ? { risk } : {}),
          runId,
          threadId: row.threadId,
          toolCallId: id,
          toolIdentity: requiredString(event, 'toolIdentity'),
        },
      ],
    };
    this.publishRunStatus(run, runId);
  }

  /** A rewind moves the head the composer answers from; the old branch stays. */
  private rewindHead(move: CommittedRewindHeadMove): void {
    if (move.to === 'unchanged') {
      return;
    }
    const runId = move.to === 'latest' ? [...this.runs.keys()].at(-1) : move.runId;
    if (runId === undefined) {
      throw new Error('Committed rewind redo has no projected run.');
    }
    const headId = runId === null ? null : this.runs.get(runId)?.messageId;
    if (headId === undefined) {
      throw new Error('Committed rewind names no projected run.');
    }
    this.view = { ...this.view, repository: { ...this.view.repository, headId } };
  }

  private apply(row: CommittedAssistantLogRow): void {
    const event = row.event;
    if (event['type'] === 'run.started') {
      this.start(row);
      return;
    }
    const rewound = this.rewinds.fold(event);
    if (rewound) {
      this.rewindHead(rewound);
      return;
    }
    if (typeof event['runId'] !== 'string') {
      return;
    }
    const run = this.runs.get(event['runId']);
    if (!run) {
      throw new Error('Committed run event has no canonical run.started identity.');
    }
    if (event['type'] === 'stream.chunk') {
      this.stream(run, row);
    } else if (event['type'] === 'model.step') {
      const usage = record(event['usage']);
      const inputTokens = usage?.['inputTokens'];
      const outputTokens = usage?.['outputTokens'];
      if (
        typeof inputTokens === 'number' &&
        typeof outputTokens === 'number' &&
        Number.isFinite(inputTokens) &&
        Number.isFinite(outputTokens) &&
        inputTokens >= 0 &&
        outputTokens >= 0 &&
        inputTokens + outputTokens > 0 &&
        (this.view.contextUsage?.inputTokens !== inputTokens ||
          this.view.contextUsage.outputTokens !== outputTokens)
      ) {
        this.view = { ...this.view, contextUsage: { inputTokens, outputTokens } };
      }
      this.commitStepText(run, event['messages']);
      this.data(run, row, event, HOST_EVENT_DATA_NAME);
    } else if (event['type'] === 'model.messages' && run.stepOpen) {
      // Only a Stop's partial reply commits assistant text inside an open step.
      this.commitStepText(run, event['messages']);
      this.other(run, row);
    } else if (event['type'] === 'interaction.requested') {
      this.request(run, row, event, event['runId']);
    } else if (event['type'] === 'interaction.responded') {
      const interaction = this.view.pendingInteractions.find(
        (item) => item.runId === event['runId'] && item.interactionId === event['interactionId']
      );
      if (!interaction) {
        throw new Error('Committed decision has no matching pending host interaction.');
      }
      this.updateTool(run, interaction.toolCallId, (part) => ({
        ...part,
        approval: {
          ...part.approval,
          approved: committedInteractionApproved(interaction.kind, event),
          id: interaction.interactionId,
        },
      }));
      this.view = {
        ...this.view,
        pendingInteractions: this.view.pendingInteractions.filter((item) => item !== interaction),
      };
      this.publishRunStatus(run, event['runId']);
    } else if (event['type'] === 'effect.started') {
      this.tool(run, event, true);
    } else if (event['type'] === 'effect.finished') {
      const id = requiredString(event, 'toolCallId');
      this.updateTool(run, id, (part) => ({ ...part, isError: false, result: event['output'] }));
      run.authoritativeResults.add(id);
    } else if (event['type'] === 'run.finished') {
      this.finish(run, row, event);
    } else {
      this.other(run, row);
    }
  }
}
