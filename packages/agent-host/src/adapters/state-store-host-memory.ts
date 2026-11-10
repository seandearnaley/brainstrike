import {
  createProviderRequestMiddleware,
  healInterruptedModelMessages,
  type ProviderRequestContext,
  preparedPromptBreakdown,
  preparedPromptToolCalls,
} from '@brainstrike/agent/provider-request';
import {
  applyPromptToolCallWindow,
  diffPromptToolCallWindow,
  type PromptToolCall,
} from '@brainstrike/assistant-contract/context-breakdown';
import { createLogger } from '@brainstrike/logging';
import type { StateStore } from '@brainstrike/state-store';
import type { MastraDBMessage } from '@mastra/core/agent';
import { MessageList } from '@mastra/core/agent';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
  type LanguageModel,
  type LanguageModelMiddleware,
  type ModelMessage,
  modelMessageSchema,
  wrapLanguageModel,
} from 'ai';
import { withHostDeliveryLedger } from '../child-delivery.ts';
import {
  committedRowAddress,
  committedRunAncestors,
  committedRunIdentity,
  committedThreadBranches,
} from '../committed-identities.ts';
import { compactedRunIds } from '../context-compaction.ts';
import type {
  HostPreparedStep,
  HostProjectionRewrite,
  HostRunContext,
  HostRunOwner,
} from '../ports.ts';
import { committedRewrites } from '../projection-rewrites.ts';
import type { HostLogRow } from '../protocol.ts';
import { HostRunOwnerCleanupError, HostRunOwnerFailure } from '../run-admission.ts';
import { isHostTurnInput } from '../turn-input.ts';
import { committedMemoryTranscript } from './committed-memory-transcript.ts';
import {
  HostMemory,
  type HostMemoryCapabilities,
  type HostMemoryIdentity,
  HostMemoryStepError,
  type HostMemoryStepName,
} from './memory.ts';
import { classifyMemoryFailure } from './memory-failure.ts';
import { StateStoreMemoryStorage } from './memory-storage.ts';

const logger = createLogger('AgentHostMemory');

/**
 * OM keeps one merged observation text per thread, with no per-message
 * provenance to filter by, so a run on a branched thread receives none.
 */
function withholdsObservation(
  observation: unknown,
  rows: readonly HostLogRow[],
  runId: string
): boolean {
  if (
    !observation ||
    (typeof observation === 'object' && Reflect.get(observation, 'enabled') === false)
  ) {
    return false;
  }
  return committedThreadBranches(rows, runId);
}

/** This run's native Memory: without OM on a branched thread, with its reason committed. */
async function selectRunMemory(
  native: StateStoreHostMemoryOptions['native'],
  rows: readonly HostLogRow[],
  context: HostRunContext
): Promise<StateStoreHostMemoryOptions['native']> {
  if (!withholdsObservation(native.options?.observationalMemory, rows, context.runId)) {
    return native;
  }
  if (!context.recordObservationWithheld) {
    throw new Error('Withheld observational memory requires the host-owned receipt writer');
  }
  await context.recordObservationWithheld('branched-thread');
  logger.info('Observational memory withheld from a branched thread', {
    code: 'host_memory_observation_withheld',
    reason: 'branched-thread',
    runId: context.runId,
    threadId: context.threadId,
  });
  return { ...native, options: { ...native.options, observationalMemory: false } };
}
export interface StateStoreHostMemoryOptions {
  readonly native: Omit<HostMemoryCapabilities['native'], 'storage'>;
  /** The observer's catalog `provider::model`; required when observational memory is on. */
  readonly observerModelId?: string;
  readonly providerRequestContext?: () => ProviderRequestContext | Promise<ProviderRequestContext>;
  readonly recordObserverUsage?: HostMemoryCapabilities['recordObserverUsage'];
  readonly recordPrompt: HostMemoryCapabilities['recordPrompt'];
  /**
   * Told once the owner has joined and closed, so whatever keeps it by its run
   * (an admission shared by delegated runs) drops it: a closed owner's public
   * Memory and its WebAssembly hasher must not outlive the run.
   */
  readonly released?: () => void;
  readonly resourceId: string;
  readonly store: StateStore;
}

/** The existing run owner encloses public Memory and its borrowed writer domain. */
export class StateStoreHostMemory implements HostRunOwner {
  private closing: Promise<void> | undefined;
  private preparedProviderHistory: readonly MastraDBMessage[] | undefined;
  /** Committed tool-output rewrites as of this step's history read. */
  private preparedRewrites: ReadonlyMap<string, HostProjectionRewrite> = new Map();
  /** The tool calls this run's previous provider request carried; none before its first. */
  private previousRequestToolCalls: ReadonlyMap<string, PromptToolCall> | undefined;
  /**
   * Memory's context as the run's first step read it: its system text, the
   * earlier turns it selected and its continuation hint, kept together. Every
   * later step sends the same prefix: a working-memory update or a settled
   * observation mid-run would otherwise rewrite it, and every provider's
   * prompt cache misses from the first changed token (Anthropic and OpenAI
   * both ask for dynamic content after the cached prefix). An observation
   * that covers earlier turns replaces them only from the next run, so no
   * request drops a turn its observation does not yet carry. The model sees
   * its own working-memory update as the tool call in its history.
   */
  private runContext:
    | {
        readonly continuationMessage: MastraDBMessage | undefined;
        readonly selected: ReadonlySet<string>;
        readonly system: string;
      }
    | undefined;

  readonly memory: HostMemory;
  private readonly identity: HostMemoryIdentity;
  private readonly domain: StateStoreMemoryStorage;
  private readonly storage: MastraCompositeStore;
  /** The given threads' committed rows, or the whole resource's without them. */
  private readonly readRows: (threadIds?: ReadonlySet<string>) => Promise<HostLogRow[]>;
  private readonly providerContext: ProviderRequestContext | undefined;
  private readonly released: (() => void) | undefined;

  private constructor(
    memory: HostMemory,
    identity: HostMemoryIdentity,
    domain: StateStoreMemoryStorage,
    storage: MastraCompositeStore,
    readRows: (threadIds?: ReadonlySet<string>) => Promise<HostLogRow[]>,
    providerContext: ProviderRequestContext | undefined,
    released: (() => void) | undefined
  ) {
    this.memory = memory;
    this.identity = identity;
    this.domain = domain;
    this.storage = storage;
    this.readRows = readRows;
    this.providerContext = providerContext;
    this.released = released;
  }

  static async open(
    context: HostRunContext,
    options: StateStoreHostMemoryOptions
  ): Promise<StateStoreHostMemory> {
    try {
      return await StateStoreHostMemory.openOwner(context, options);
    } catch (cause) {
      throw memoryOpenFailure(context.signal, cause);
    }
  }

  private static async openOwner(
    context: HostRunContext,
    options: StateStoreHostMemoryOptions
  ): Promise<StateStoreHostMemory> {
    // Snapshot configuration before constructing native run-owned resources.
    const providerContext = await options.providerRequestContext?.();
    const inputRows = context.readCommittedRows(new Set([context.threadId]));
    const native = await selectRunMemory(options.native, inputRows, context);
    const readRows = (threadIds?: ReadonlySet<string>): Promise<HostLogRow[]> =>
      readMemoryRows(context, options, threadIds);
    const readTranscript = async (threadIds?: ReadonlySet<string>): Promise<MastraDBMessage[]> =>
      committedMemoryTranscript(await readRows(threadIds), options.resourceId);
    const ownThread = new Set([context.threadId]);
    const identity = { ...context, resourceId: options.resourceId };
    const domain = new StateStoreMemoryStorage(
      options.resourceId,
      options.store,
      {
        read: readTranscript,
      },
      context.threadId
    );
    const storage = new MastraCompositeStore({
      domains: { memory: domain },
      id: options.resourceId,
    });
    const memory = new HostMemory(identity, {
      native: { ...native, storage },
      ...(options.observerModelId === undefined
        ? {}
        : { observerModelId: options.observerModelId }),
      recordMemoryCycle: async (_current, cycle) => {
        if (!context.recordMemoryCycle) {
          throw new Error('Public Memory requires the host-owned memory cycle writer');
        }
        await context.recordMemoryCycle(cycle);
      },
      recordObserverUsage: async (current, receipt) => {
        if (!context.recordObserverUsage) {
          throw new Error('Public Memory requires the host-owned usage receipt writer');
        }
        await context.recordObserverUsage(receipt);
        await options.recordObserverUsage?.(current, receipt);
      },
      recordPrompt: options.recordPrompt,
    });
    const owner = new StateStoreHostMemory(
      memory,
      identity,
      domain,
      storage,
      readRows,
      providerContext,
      options.released
    );
    try {
      await storage.init();
      const committed = committedRunIdentity(inputRows, context.runId);
      if (!(await domain.getThreadById({ threadId: context.threadId }))) {
        await domain.saveThread({
          thread: {
            createdAt: committed.createdAt,
            id: context.threadId,
            metadata: {},
            resourceId: options.resourceId,
            updatedAt: committed.createdAt,
          },
        });
      }
      const rows = await readRows(ownThread);
      const currentIds = new Set(
        rows.flatMap((row) =>
          'runId' in row.event && row.event.runId === context.runId
            ? [committedRowAddress(row)]
            : []
        )
      );
      currentIds.add(committed.userMessageId);
      const current = (await readTranscript(ownThread)).filter((message) =>
        currentIds.has(message.id)
      );
      await memory.beginTurn(current);
      return owner;
    } catch (cause) {
      throw await retireFailedOpen(owner, owner.stepFailure('open', cause));
    }
  }

  /** A step's typed failure; cancellation and unjoined cleanup keep their identity. */
  private stepFailure(step: HostMemoryStepName, cause: unknown): unknown {
    return keepsIdentity(this.identity.signal, cause)
      ? cause
      : this.memory.stepFailure(step, cause);
  }

  prepareHostModel(model: LanguageModel): LanguageModel {
    const selected = this.providerContext;
    if (!selected) {
      return model;
    }
    if (typeof model === 'string') {
      throw new Error('Host provider preparation requires the selected concrete model');
    }
    const middleware = createProviderRequestMiddleware({
      context: async () => {
        const history = this.preparedProviderHistory;
        if (history === undefined) {
          throw new Error('Provider request requires its prepared Memory selection');
        }
        return { ...selected, history, rewrites: this.preparedRewrites };
      },
      onPrepared: async (prepared) => {
        if (!this.identity.recordProviderRequest) {
          throw new Error('Provider preparation requires the host-owned receipt writer');
        }
        const toolCalls = preparedPromptToolCalls(prepared);
        const toolCallWindow = diffPromptToolCallWindow(this.previousRequestToolCalls, toolCalls);
        await this.identity.recordProviderRequest({
          accounting: prepared.accounting,
          breakdown: preparedPromptBreakdown(prepared, toolCalls),
          modelId: model.modelId,
          provider: selected.provider,
          toolCallWindow,
        });
        // Only a committed receipt becomes the next window's base.
        this.previousRequestToolCalls = applyPromptToolCallWindow(
          this.previousRequestToolCalls,
          toolCallWindow
        );
        try {
          await this.memory.recordPrompt(prepared.params);
        } catch (cause) {
          // Memory's own failure inside the chat model call: never a provider error.
          throw this.stepFailure('accounting', cause);
        }
      },
    });
    return wrapLanguageModel({
      // Both pins implement the public V4 primitive. The older provider's
      // declaration omits readonly JSON, while the installed SDK permits it.
      // Keep this DTO type bridge here; adding ai 7 to the legacy agent package
      // would change its separate Mastra/ai 6 peer closure. Joined tests compare
      // the prepared public params to the actual SDK model call without copies.
      // https://github.com/vercel/ai/tree/main/packages/provider
      // Remove this type bridge when both existing declaration pins agree.
      middleware: middleware as unknown as LanguageModelMiddleware,
      model,
    });
  }

  async prepareHostStep(request: {
    readonly messages: readonly ModelMessage[];
    readonly stepNumber: number;
  }): Promise<HostPreparedStep> {
    try {
      return await this.selectStep(request);
    } catch (cause) {
      throw this.stepFailure('context', cause);
    }
  }

  private async selectStep(request: {
    readonly messages: readonly ModelMessage[];
    readonly stepNumber: number;
  }): Promise<HostPreparedStep> {
    this.preparedProviderHistory = undefined;
    const currentUser = request.messages.findLastIndex(isHostTurnInput);
    if (currentUser < 0) {
      throw new Error('Memory preparation has no current committed user input');
    }
    // Memory still prepares every step (its observer runs here); only the
    // context it sends is the run's first.
    const step = await this.memory.prepareStep(request.stepNumber);
    // Active SDK messages retain their actual validated approval/runtime objects.
    // Public Memory selects previous committed turns, never reconstructs an
    // active call or changes the existing host approval occurrence.
    this.runContext ??= {
      continuationMessage: step.context.continuationMessage,
      selected: new Set(step.messages.map((message) => message.id)),
      system: [step.context.systemMessage, step.context.otherThreadsContext]
        .filter((part) => part !== undefined && part.length > 0)
        .join('\n\n'),
    };
    const { continuationMessage, selected, system } = this.runContext;
    const continuation = new MessageList({
      resourceId: this.identity.resourceId,
      threadId: this.identity.threadId,
    });
    if (continuationMessage) {
      continuation.add([continuationMessage], 'memory');
    }
    return await this.assembleStep({
      active: request.messages.slice(currentUser),
      continuation,
      selected,
      system,
    });
  }

  /**
   * The step's request from the committed log, over Memory's native selection.
   * Core rebuilds it after committing a compaction (ADR-0013), so
   * the compacted turns leave it without Memory preparing its step again.
   */
  private async assembleStep(native: {
    readonly active: readonly ModelMessage[];
    readonly continuation: MessageList;
    readonly selected: ReadonlySet<string>;
    readonly system: string;
  }): Promise<HostPreparedStep> {
    const { selected } = native;
    this.preparedProviderHistory = undefined;
    const rows = await this.readRows(new Set([this.identity.threadId]));
    const historical: ModelMessage[] = [];
    const historicalIds = new Set<string>();
    const historyRunIds = new Set<string>();
    // In this thread only the selected branch is history: a sibling branch's
    // turns never enter the request, even when native Memory selects them.
    const path = new Set(committedRunAncestors(rows, this.identity.runId));
    // A committed compaction replaces whole earlier turns: the native history
    // window does not re-add one (Core adds the note).
    const compacted = compactedRunIds(rows);
    this.preparedRewrites = committedRewrites(rows);
    for (const started of rows) {
      if (
        started.event.type !== 'run.started' ||
        started.event.runId === this.identity.runId ||
        compacted.has(started.event.runId) ||
        !path.has(started.event.runId)
      ) {
        continue;
      }
      const previousRunId = started.event.runId;
      const previous = committedRunIdentity(rows, previousRunId);
      // BST-1977's ordinary second turn failed when the bounded native history
      // window started inside an older turn. Its assistant tail cannot be a
      // standalone provider conversation, so only a selected question anchors
      // its committed turn.
      if (!selected.has(previous.userMessageId)) {
        continue;
      }
      historical.push(
        withHostDeliveryLedger(
          { content: started.event.prompt, role: 'user' },
          started.event.delivery
        )
      );
      historicalIds.add(previous.userMessageId);
      historyRunIds.add(previousRunId);
      if (
        !rows.some(
          (row) =>
            'runId' in row.event &&
            row.event.runId === previousRunId &&
            selected.has(committedRowAddress(row))
        )
      ) {
        continue;
      }
      const committed = rows.flatMap((row) => {
        const event = row.event;
        if (
          row.threadId === started.threadId &&
          (event.type === 'model.step' || event.type === 'model.messages') &&
          event.runId === previousRunId
        ) {
          historicalIds.add(committedRowAddress(row));
          return event.messages.map((message) => modelMessageSchema.parse(message));
        }
        return [];
      });
      const interrupted = rows.flatMap(({ event }) =>
        event.type === 'run.finished' &&
        event.runId === previousRunId &&
        (event.outcome === 'interrupted' || event.outcome === 'stopped')
          ? [event.outcome]
          : []
      )[0];
      if (interrupted) {
        const calls = new Set(
          committed.flatMap((message) =>
            message.role === 'assistant' && typeof message.content !== 'string'
              ? message.content.flatMap((part) =>
                  part.type === 'tool-call' ? [part.toolCallId] : []
                )
              : []
          )
        );
        historical.push(...healInterruptedModelMessages(committed, calls, interrupted));
      } else {
        historical.push(...committed);
      }
    }
    const { continuation, system } = native;
    this.captureProviderHistory(rows, historicalIds, continuation.get.all.db());
    return {
      historyRunIds,
      messages: [
        ...historical,
        ...continuation.get.all.aiV5.model().map((message) => modelMessageSchema.parse(message)),
        ...native.active,
      ],
      rebuild: async () => {
        try {
          return await this.assembleStep(native);
        } catch (cause) {
          throw this.stepFailure('context', cause);
        }
      },
      rewrites: this.preparedRewrites,
      ...(system ? { system } : {}),
    };
  }

  private captureProviderHistory(
    rows: readonly HostLogRow[],
    historicalIds: ReadonlySet<string>,
    continuation: readonly MastraDBMessage[]
  ): void {
    // Provenance borrows the exact committed occurrences emitted above. A
    // resource-wide queue can lose a selected known call when an omitted
    // unknown turn reuses its SDK ID. The active SDK suffix includes this run's
    // committed continuations; historical truth stays intact.
    const currentIds = new Set<string>();
    currentIds.add(committedRunIdentity(rows, this.identity.runId).userMessageId);
    for (const row of rows) {
      if (
        row.threadId === this.identity.threadId &&
        'runId' in row.event &&
        row.event.runId === this.identity.runId
      ) {
        currentIds.add(committedRowAddress(row));
      }
    }
    const native = committedMemoryTranscript(rows, this.identity.resourceId);
    this.preparedProviderHistory = [
      ...native.filter((message) => historicalIds.has(message.id)),
      ...continuation,
      ...native.filter((message) => currentIds.has(message.id)),
    ];
  }

  async commitHostStep(): Promise<void> {
    try {
      await this.commitStep();
    } catch (cause) {
      throw this.stepFailure('save', cause);
    }
  }

  private async commitStep(): Promise<void> {
    const rows = await this.readRows(new Set([this.identity.threadId]));
    const committed = committedRunIdentity(rows, this.identity.runId);
    const currentIds = new Set(
      rows.flatMap((row) =>
        'runId' in row.event && row.event.runId === this.identity.runId
          ? [committedRowAddress(row)]
          : []
      )
    );
    currentIds.add(committed.userMessageId);
    const current = committedMemoryTranscript(rows, this.identity.resourceId).filter((message) =>
      currentIds.has(message.id)
    );
    await this.memory.commitStep(current);
  }

  /** The run's foreground memory work; storage stays open for the native settlement. */
  endTurn(): Promise<void> {
    return this.memory.endTurn();
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      let failure: unknown;
      try {
        await this.memory.close();
      } catch (cause) {
        // Still-owned native work may yet write its flags: storage stays open
        // and the run stays owned.
        if (cause instanceof HostRunOwnerCleanupError) {
          throw cause;
        }
        failure = cause;
      }
      try {
        await this.domain.close();
      } catch (cause) {
        // Its operations drained and failed: the run's outcome, not a leak.
        if (!(cause instanceof HostRunOwnerFailure)) {
          throw new HostRunOwnerCleanupError(
            failure ?? cause,
            cause,
            'Memory storage cleanup failed'
          );
        }
        failure ??= cause;
      }
      try {
        await this.storage.close();
      } catch (cleanup) {
        throw new HostRunOwnerCleanupError(
          failure ?? cleanup,
          cleanup,
          'Memory storage cleanup failed'
        );
      }
      this.released?.();
      // Every memory tail joined and storage closed: a failure is the run's outcome.
      if (failure !== undefined) {
        throw failure;
      }
    })();
    return this.closing;
  }
}

/**
 * A failed open closes its owner. A joined memory failure belongs to the open's
 * failure; only work the owner could not join is a cleanup failure that
 * retains the run.
 */
async function retireFailedOpen(owner: StateStoreHostMemory, cause: unknown): Promise<unknown> {
  try {
    await owner.close();
  } catch (cleanup) {
    if (cleanup instanceof HostRunOwnerCleanupError) {
      return new HostRunOwnerCleanupError(cause, cleanup, 'Memory construction cleanup failed');
    }
  }
  return cause;
}

/** Cancellation and unjoined cleanup keep their identity through a memory step. */
function keepsIdentity(signal: AbortSignal, cause: unknown): boolean {
  return cause instanceof HostRunOwnerCleanupError || (signal.aborted && cause === signal.reason);
}

/**
 * An open that failed before its owner existed: a typed failure its producer
 * gave it (memory's configuration), else the internal fault (BST-2202).
 */
function memoryOpenFailure(signal: AbortSignal, cause: unknown): unknown {
  return keepsIdentity(signal, cause)
    ? cause
    : HostMemoryStepError.wrap(
        'open',
        cause,
        classifyMemoryFailure('open', cause, { attribution: () => undefined })
      );
}

/**
 * The committed rows of the resource's threads Memory asks for (every thread
 * without `threadIds`). Vendor metadata cannot authorize a Root thread for the
 * acquired resource.
 */
async function readMemoryRows(
  context: HostRunContext,
  options: StateStoreHostMemoryOptions,
  threadIds?: ReadonlySet<string>
): Promise<HostLogRow[]> {
  const snapshot = await options.store.memory({
    operation: 'read',
    ownerThreadId: context.threadId,
    resourceId: options.resourceId,
  });
  const threads = new Set<string>();
  for (const entity of snapshot.entities) {
    if (entity.kind !== 'thread') {
      continue;
    }
    if (
      entity.threadId !== entity.id ||
      entity.payload['id'] !== entity.id ||
      entity.payload['resourceId'] !== options.resourceId
    ) {
      throw new Error('Durable Memory thread binding crossed its resource owner');
    }
    threads.add(entity.id);
  }
  if (!threads.has(context.threadId)) {
    throw new Error('Acquired Memory thread has no durable resource binding');
  }
  // Core's committed-row projection: history without a store scan or re-decode,
  // and only the threads asked for, so a thread's read does not grow with the
  // resource's other threads.
  const scope = threadIds ? new Set([...threadIds].filter((id) => threads.has(id))) : threads;
  return [...context.readCommittedRows(scope)];
}
