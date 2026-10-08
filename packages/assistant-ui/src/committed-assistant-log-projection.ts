import {
  type ExportedMessageRepository,
  fromThreadMessageLike,
  type ThreadAssistantMessage,
  type ThreadMessage,
} from '@assistant-ui/react';
import { parsePartialJsonObject } from 'assistant-stream/utils';
import type { ThreadTokenUsage } from './context-usage-store';

/** Structural consumer boundary for the owner's validated HostLogRow, not a wire schema. */
export interface CommittedAssistantLogRow {
  readonly event: Readonly<Record<string, unknown>>;
  readonly seq: number;
  readonly threadId: string;
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

export interface CommittedAssistantPendingInteraction {
  readonly interactionId: string;
  readonly kind?: 'approval' | 'question' | 'plan';
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly toolIdentity: string;
}

export interface CommittedAssistantLogView {
  readonly activeRunId: string | undefined;
  /** Latest chat provider step, never aggregate billing or observer usage. */
  readonly contextUsage?: ThreadTokenUsage | undefined;
  readonly isRunning: boolean;
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
  readonly messageId: string;
  readonly partIndexes: Map<string, number>;
  step: number;
  terminal: boolean;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) {
    throw new Error(`Committed host event is missing ${key}.`);
  }
  return field;
}

function providerMetadata(value: unknown): ToolPart['providerMetadata'] {
  const providers = record(value);
  if (!providers || Object.values(providers).some((entry) => !record(entry))) {
    return undefined;
  }
  // The owner has already validated JSON at the public HostLogRow boundary.
  return providers as ToolPart['providerMetadata'];
}

function mergeProviderMetadata(
  previous: ToolPart['providerMetadata'],
  incoming: ToolPart['providerMetadata'],
  ownership?: NonNullable<ToolPart['providerMetadata']>[string]
): ToolPart['providerMetadata'] {
  const additions = ownership
    ? { ...incoming, brainstrike: { ...incoming?.['brainstrike'], ...ownership } }
    : incoming;
  if (!additions) {
    return previous;
  }
  let next = previous;
  for (const [namespace, fields] of Object.entries(additions)) {
    const before = previous?.[namespace];
    if (Object.entries(fields).every(([key, value]) => before?.[key] === value)) {
      continue;
    }
    next = { ...next, [namespace]: { ...before, ...fields } };
  }
  return next;
}

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
  const name = typeof input['toolId'] === 'string' ? input['toolId'] : input['toolName'];
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

  private part(run: ProjectedRun, key: string, update: (previous?: Part) => Part): void {
    const message = this.message(run);
    const index = run.partIndexes.get(key) ?? message.content.length;
    const previous = message.content[index];
    const next = update(previous);
    if (next === previous) {
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
      const user = fromThreadMessageLike(
        {
          content: [{ text: requiredString(row.event, 'prompt'), type: 'text' }],
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
      messageId: message.id,
      partIndexes: new Map(),
      step: 0,
      terminal: false,
    });
    this.view = {
      ...this.view,
      activeRunId: runId,
      isRunning: true,
      repository: { ...this.view.repository, headId: message.id },
    };
  }

  private stream(run: ProjectedRun, row: CommittedAssistantLogRow): void {
    const chunk = record(row.event['chunk']);
    if (!chunk) {
      this.data(run, row, row.event['chunk'], 'brainstrike.host-stream');
      return;
    }
    const type = chunk['type'];
    if ((type === 'data' || type === 'aui-data') && typeof chunk['name'] === 'string') {
      this.data(run, row, chunk['data'], chunk['name']);
      return;
    }
    if (type === 'start-step') {
      run.step += 1;
    } else if (
      type === 'text-start' ||
      type === 'text-delta' ||
      type === 'text-end' ||
      type === 'reasoning-start' ||
      type === 'reasoning-delta' ||
      type === 'reasoning-end'
    ) {
      const partType = type.startsWith('reasoning') ? 'reasoning' : 'text';
      const key = JSON.stringify([run.step, partType, chunk['id'] ?? null]);
      this.part(run, key, (part) => {
        const prior = part?.type === partType ? part : undefined;
        const delta = typeof chunk['text'] === 'string' ? chunk['text'] : '';
        const metadata = mergeProviderMetadata(
          prior?.providerMetadata,
          providerMetadata(chunk['providerMetadata'])
        );
        return {
          ...prior,
          type: partType,
          ...(metadata ? { providerMetadata: metadata } : {}),
          status: type.endsWith('-end')
            ? { type: 'complete' }
            : (prior?.status ?? { type: 'running' }),
          text: (prior?.text ?? '') + (type.endsWith('-delta') ? delta : ''),
        };
      });
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
    }
    // SDK approval IDs are intentionally never native decision identities.
    // Preserve unhandled rich chunks and provider/child data verbatim.
    this.data(run, row, chunk, 'brainstrike.host-stream');
  }

  private finish(run: ProjectedRun, event: Readonly<Record<string, unknown>>): void {
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

  private apply(row: CommittedAssistantLogRow): void {
    const event = row.event;
    if (event['type'] === 'run.started') {
      this.start(row);
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
      this.data(run, row, event, 'brainstrike.host-event');
    } else if (event['type'] === 'interaction.requested') {
      const id = this.tool(run, event, true);
      const interactionId = requiredString(event, 'interactionId');
      const kind = event['kind'];
      if (kind !== 'approval' && kind !== 'question' && kind !== 'plan') {
        throw new Error('Committed interaction has an unsupported kind.');
      }
      this.updateTool(run, id, (part) => ({
        ...part,
        approval: {
          id: interactionId,
          ...(kind === 'approval' ? {} : { allowFreeform: true, display: 'text' as const }),
        },
        ...(kind === 'approval'
          ? {}
          : {
              providerMetadata: {
                ...part.providerMetadata,
                brainstrike: { ...part.providerMetadata?.['brainstrike'], interactionKind: kind },
              },
            }),
      }));
      this.view = {
        ...this.view,
        pendingInteractions: [
          ...this.view.pendingInteractions,
          {
            interactionId,
            kind,
            runId: event['runId'],
            threadId: row.threadId,
            toolCallId: id,
            toolIdentity: requiredString(event, 'toolIdentity'),
          },
        ],
      };
      this.publishRunStatus(run, event['runId']);
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
          approved: interaction.kind !== 'approval' || event['decision'] === 'approve',
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
      this.finish(run, event);
    } else {
      this.data(run, row, event, 'brainstrike.host-event');
    }
  }
}
