import type { ProviderRequestContext } from '@brainstrike/agent/provider-request';
import { createLogger } from '@brainstrike/logging';
import type { StateStore } from '@brainstrike/state-store';
import type { MastraDBMessage } from '@mastra/core/agent';
import { MessageList } from '@mastra/core/agent';
import { MastraCompositeStore } from '@mastra/core/storage';
import { type LanguageModel, type ModelMessage, modelMessageSchema } from 'ai';
import {
  committedRowAddress,
  committedRunIdentity,
  committedThreadBranches,
} from '../committed-identities.ts';
import { committedTranscript } from '../committed-transcript.ts';
import type { HostPreparedStep, HostRunContext, HostRunOwner } from '../ports.ts';
import { committedRewrites } from '../projection-rewrites.ts';
import type { HostLogRow } from '../protocol.ts';
import { HostRunOwnerCleanupError, HostRunOwnerFailure } from '../run-admission.ts';
import { committedRunHistory, hostProviderHistory } from '../run-history.ts';
import { HostProviderRequest } from '../run-provider-request.ts';
import { isHostTurnInput } from '../turn-input.ts';
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
  /** The run's provider request boundary, when its admission selected a provider. */
  private readonly request: HostProviderRequest | undefined;
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
    this.request =
      providerContext &&
      new HostProviderRequest(providerContext, identity.recordProviderRequest, async (prepared) => {
        try {
          await this.memory.recordPrompt(prepared.params);
        } catch (cause) {
          // Memory's own failure inside the chat model call: never a provider error.
          throw this.stepFailure('accounting', cause);
        }
      });
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
      committedTranscript(await readRows(threadIds), options.resourceId);
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
    return this.request?.wrap(model) ?? model;
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
    this.request?.clear();
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
   * The step's request from the committed log (`committedRunHistory`), over
   * Memory's native selection. Core rebuilds it after committing a compaction
   * (ADR-0013), so the compacted turns leave it without Memory preparing its
   * step again.
   */
  private async assembleStep(native: {
    readonly active: readonly ModelMessage[];
    readonly continuation: MessageList;
    readonly selected: ReadonlySet<string>;
    readonly system: string;
  }): Promise<HostPreparedStep> {
    this.request?.clear();
    const rows = await this.readRows(new Set([this.identity.threadId]));
    const rewrites = committedRewrites(rows);
    const history = committedRunHistory(rows, this.identity, native.selected);
    const { continuation, system } = native;
    this.request?.prepare(
      hostProviderHistory(rows, this.identity, history.ids, continuation.get.all.db()),
      rewrites
    );
    return {
      historyRunIds: history.runIds,
      messages: [
        ...history.messages,
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
      rewrites,
      ...(system ? { system } : {}),
    };
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
    const current = committedTranscript(rows, this.identity.resourceId).filter((message) =>
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
