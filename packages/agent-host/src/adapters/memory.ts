import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import { noopObserve } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import type { LanguageModelMiddleware, LanguageModelUsage } from 'ai';
import type { HostRunContext, HostRunOwner } from '../ports.js';
import { HostRunOwnerCleanupError, HostRunOwnerFailure } from '../run-admission.js';
import { type MemoryLanguageModel, MemoryProviderLifetime } from './memory-provider-lifetime.js';

type MemoryConfig = NonNullable<ConstructorParameters<typeof Memory>[0]>;
type Engine = NonNullable<Awaited<Memory['omEngine']>>;
type Turn = ReturnType<Engine['beginTurn']>;
type PreparedStep = Awaited<ReturnType<ReturnType<Turn['step']>['prepare']>>;
type NativeContext = Awaited<ReturnType<Memory['getContext']>>;
type ProviderRequest = Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0]['params'];

export interface HostMemoryIdentity extends HostRunContext {
  readonly resourceId: string;
}

export interface HostMemoryCapabilities {
  /** Instantiate the public native leaf only after all run lifetime wrapping. */
  readonly createNativeMemory?: (native: HostMemoryCapabilities['native']) => Memory;
  /**
   * Optional additional run-owned tails. Called after the patched native
   * barrier joins. The storage owner may close after HostMemory.close completes.
   */
  joinNativeLifetime?(): Promise<void>;
  /** Public Memory configuration; storage delegates to the existing StateStore writer. */
  readonly native: MemoryConfig & { readonly storage: NonNullable<MemoryConfig['storage']> };
  /** Actual observer/reflector usage and model identity, for the existing usage ledger. */
  recordObserverUsage(
    identity: HostMemoryIdentity,
    receipt: {
      readonly kind: 'observation' | 'reflection';
      readonly modelId: string;
      readonly usage: LanguageModelUsage;
    }
  ): Promise<void>;
  /** Receives the actual final public provider request, after host prompt composition. */
  recordPrompt(identity: HostMemoryIdentity, request: ProviderRequest): Promise<void>;
}

/** The run-visible memory step a failure names. */
export type HostMemoryStepName =
  | 'open'
  | 'context'
  | 'observe'
  | 'recall'
  | 'save'
  | 'working memory'
  | 'tool'
  | 'accounting'
  | 'provider';

/** A memory operation failed; its run fails with a detail naming the step. */
export class HostMemoryStepError extends Error {
  private constructor(
    readonly step: HostMemoryStepName,
    cause: unknown
  ) {
    super(`Memory ${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'HostMemoryStepError';
  }

  /** The first labelled step is kept when a failure crosses nested operations. */
  static wrap(step: HostMemoryStepName, cause: unknown): HostMemoryStepError {
    return cause instanceof HostMemoryStepError ? cause : new HostMemoryStepError(step, cause);
  }
}

/**
 * Every memory tail joined, but these operations failed: the run's outcome,
 * not a leak. The original failures are retained; the message names the step.
 */
export class HostMemoryFailure extends HostRunOwnerFailure {
  constructor(failures: readonly unknown[], message: string) {
    super(failures, message);
    this.name = 'HostMemoryFailure';
  }
}

/** The patched barrier's marker for native work it still owns after its drain bound. */
function stillOwnsNativeWork(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === 'ObservationalMemoryIncompleteSettlementError' ||
    stillOwnsNativeWork(error.cause) ||
    (error instanceof AggregateError && error.errors.some(stillOwnsNativeWork))
  );
}

export interface HostMemoryStep {
  readonly context: NativeContext;
  readonly messages: readonly MastraDBMessage[];
  readonly observation: PreparedStep | undefined;
  readonly workingMemory: string | null;
}

/**
 * Public-library adapter for the existing host run owner. The caller projects
 * committed transcript messages into storage; this adapter creates no writer,
 * permission gate, provider, scheduler or replacement memory framework.
 *
 * The isolated M3 compatibility patch supplies native cancellation, failure
 * retention and a fail-closed settlement barrier. The public provider enclosure
 * additionally joins raw promises, original sources and actual usage receipts.
 * Root admission, strict purge, derived cleanup and lease retention remain host-owned.
 * Upstream primitive: https://github.com/mastra-ai/mastra/tree/main/packages/memory
 * Remove the temporary patch when the pinned public memory library or M4 memory
 * implementation passes the same cancellation/join/error regressions unmodified.
 */
export class HostMemory implements HostRunOwner {
  private readonly memory: Memory;
  private readonly providers: MemoryProviderLifetime;
  private readonly messageList: MessageList;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failures: unknown[] = [];
  /** The innermost step each retained failure came from. */
  private readonly failureSteps = new WeakMap<object, HostMemoryStepName>();
  private turn: Turn | undefined;
  private beginning: Promise<NativeContext> | undefined;
  private closing: Promise<void> | undefined;
  private joined = false;

  constructor(
    readonly identity: HostMemoryIdentity,
    private readonly capabilities: HostMemoryCapabilities
  ) {
    this.providers = new MemoryProviderLifetime(identity.signal, (receipt) =>
      this.recordObserverUsage(receipt)
    );
    let native = capabilities.native;
    if (native.embedder && typeof native.embedder === 'object') {
      native = { ...native, embedder: this.providers.embedding(native.embedder) };
    }
    if (native.vector) {
      native = { ...native, vector: this.providers.vector(native.vector) };
    }
    const observation = native.options?.observationalMemory;
    if (observation && readProperty(observation, 'enabled') !== false) {
      const sharedModel = readModel(observation);
      const observer = readModel(readProperty(observation, 'observation')) ?? sharedModel;
      const reflector = readModel(readProperty(observation, 'reflection')) ?? sharedModel;
      // ADR-0013 and the existing memory credential boundary: descriptors and
      // routing strings cannot trigger Mastra's implicit credential resolution.
      if (!(isConcreteModel(observer) && isConcreteModel(reflector))) {
        throw new Error(
          'Observational memory requires resolved concrete observer and reflector models'
        );
      }
      if (typeof observation === 'object') {
        native = {
          ...native,
          options: {
            ...native.options,
            observationalMemory: {
              ...observation,
              abortSignal: identity.signal,
              model: undefined,
              observation: {
                ...observation.observation,
                model: this.providers.model('observation', observer),
              },
              reflection: {
                ...observation.reflection,
                model: this.providers.model('reflection', reflector),
              },
            },
          },
        };
      }
    }
    this.memory = capabilities.createNativeMemory
      ? capabilities.createNativeMemory(native)
      : new Memory(native);
    this.messageList = new MessageList({
      resourceId: identity.resourceId,
      threadId: identity.threadId,
    });
  }

  private expectedCancellation(cause: unknown, providerCancellation: boolean): boolean {
    return (
      this.providers.ownsCancellation(cause) ||
      (providerCancellation &&
        this.identity.signal.aborted &&
        cause === this.identity.signal.reason)
    );
  }

  private track<Value>(
    step: HostMemoryStepName,
    operation: () => Promise<Value>,
    providerCancellation = false
  ): Promise<Value> {
    const work = Promise.resolve().then(operation);
    this.pending.add(work);
    work.then(
      () => this.pending.delete(work),
      (cause: unknown) => {
        this.pending.delete(work);
        if (!this.expectedCancellation(cause, providerCancellation)) {
          this.failures.push(cause);
          // Nested operations settle innermost first, so the first step sticks.
          if (typeof cause === 'object' && cause !== null && !this.failureSteps.has(cause)) {
            this.failureSteps.set(cause, step);
          }
        }
      }
    );
    return work;
  }

  private admit<Value>(
    step: HostMemoryStepName,
    operation: () => Promise<Value>,
    providerCancellation = false
  ): Promise<Value> {
    if (this.closing) {
      return Promise.reject(new Error('Host memory admission is closed'));
    }
    try {
      this.identity.signal.throwIfAborted();
    } catch (cause) {
      return Promise.reject(cause);
    }
    return this.track(step, operation, providerCancellation).catch((cause: unknown) => {
      // Keep provenance inside the enclosure; the existing Core contract
      // receives its original run reason for the expected cancellation.
      throw this.providers.ownsCancellation(cause) ? this.identity.signal.reason : cause;
    });
  }

  /** The memory step a failure this run retained came from, for its run detail. */
  failedStep(cause: unknown): HostMemoryStepName | undefined {
    return typeof cause === 'object' && cause !== null ? this.failureSteps.get(cause) : undefined;
  }

  private identifiers(): { resourceId: string; threadId: string } {
    return { resourceId: this.identity.resourceId, threadId: this.identity.threadId };
  }

  /** Current-turn committed input only; native context selects the retained history. */
  beginTurn(committedMessages: readonly MastraDBMessage[]): Promise<NativeContext> {
    if (this.closing || this.identity.signal.aborted) {
      return this.admit('open', async () => this.memory.getContext(this.identifiers()));
    }
    if (this.beginning) {
      return this.beginning;
    }
    this.beginning = this.admit(
      'open',
      async () => {
        this.messageList.add([...committedMessages], 'memory');
        const engine = await this.memory.omEngine;
        if (engine) {
          this.turn = engine.beginTurn({
            ...this.identifiers(),
            abortSignal: this.identity.signal,
            messageList: this.messageList,
          });
          await this.turn.start({
            getContext: (options) => this.track('observe', () => this.memory.getContext(options)),
            persistMessages: (messages) =>
              this.track('observe', () => this.memory.persistMessages(messages)),
          });
        }
        return this.memory.getContext(this.identifiers());
      },
      true
    );
    return this.beginning;
  }

  prepareStep(stepNumber: number): Promise<HostMemoryStep> {
    return this.admit(
      'context',
      async () => {
        if (!this.beginning) {
          throw new Error('Host memory turn has not begun');
        }
        await this.beginning;
        const turn = this.turn;
        const observation = turn
          ? await this.track('observe', () => turn.step(stepNumber).prepare(), true)
          : undefined;
        const [context, workingMemory] = await Promise.all([
          this.track('context', () => this.memory.getContext(this.identifiers())),
          this.track('working memory', () => this.memory.getWorkingMemory(this.identifiers())),
        ]);
        return {
          context,
          messages: context.messages,
          observation,
          workingMemory,
        };
      },
      true
    );
  }

  /** Only after the host committed the SDK step; preserve its stable projection IDs. */
  commitStep(committedMessages: readonly MastraDBMessage[]): Promise<void> {
    return this.admit('save', async () => {
      // Immutable committed segments retain their existing row addresses.
      this.messageList.add([...committedMessages], 'response', { merge: false });
      // Preserve the library's semantic indexing and working-memory processing;
      // raw persistMessages is only the public turn's sealed-message projection.
      try {
        await this.memory.saveMessages({ messages: [...committedMessages] });
      } catch (cause) {
        // The transcript is already committed. Retiring its cancelled derived
        // embedding succeeds only after the raw provider has physically joined.
        if (!this.providers.ownsCancellation(cause)) {
          throw cause;
        }
      }
    });
  }

  recall(options: Omit<Parameters<Memory['recall']>[0], 'threadId'>): ReturnType<Memory['recall']> {
    return this.admit('recall', () =>
      this.memory.recall({ ...options, threadId: this.identity.threadId })
    );
  }

  getWorkingMemory(): ReturnType<Memory['getWorkingMemory']> {
    return this.admit('working memory', () => this.memory.getWorkingMemory(this.identifiers()));
  }

  updateWorkingMemory(workingMemory: string): ReturnType<Memory['updateWorkingMemory']> {
    return this.admit('working memory', () =>
      this.memory.updateWorkingMemory({ ...this.identifiers(), workingMemory })
    );
  }

  /**
   * Execute one of the native Memory's own model-facing tools (`listTools`:
   * working memory, OM recall) with this run's identities, as Mastra's agent
   * runtime supplies them. The vendor tool validates its own input.
   */
  executeTool(name: string, input: unknown, toolCallId: string): Promise<unknown> {
    return this.admit('tool', async () => {
      const tool = this.memory.listTools()[name];
      if (!tool?.execute) {
        throw new Error(`Native Memory offers this run no ${name} tool`);
      }
      const context: Parameters<typeof tool.execute>[1] & { readonly memory: Memory } = {
        abortSignal: this.identity.signal,
        agent: {
          agentId: '',
          messages: [],
          ...this.identifiers(),
          suspend: () => Promise.reject(new Error('Native Memory tools cannot suspend a host run')),
          toolCallId,
        },
        memory: this.memory,
        observe: noopObserve,
      };
      return tool.execute(input, context);
    });
  }

  recordPrompt(request: ProviderRequest): Promise<void> {
    return this.admit('accounting', () => this.capabilities.recordPrompt(this.identity, request));
  }

  recordObserverUsage(
    receipt: Parameters<HostMemoryCapabilities['recordObserverUsage']>[1]
  ): Promise<void> {
    // Already-admitted provider tails may arrive during Stop; the host ledger
    // keeps their reported spend. These writes must remain joined during close.
    if (this.joined) {
      return Promise.reject(new Error('Host memory lifetime is already joined'));
    }
    return this.track('accounting', () =>
      this.capabilities.recordObserverUsage(this.identity, receipt)
    );
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      // The run signal reaches native work and raw provider/source leaves as
      // soon as Stop aborts it, independently of this foreground drain.
      if (this.identity.signal.aborted) {
        await Promise.allSettled([this.track('provider', () => this.providers.join())]);
      }
      await this.drain();
      if (this.turn && !this.turn.ended) {
        const turn = this.turn;
        await Promise.allSettled([this.track('observe', () => turn.end())]);
      }
      const native = await Promise.allSettled([this.track('observe', () => this.memory.settled())]);
      const enclosing = await Promise.allSettled([
        this.track('observe', () => this.capabilities.joinNativeLifetime?.() ?? Promise.resolve()),
      ]);
      const providers = await Promise.allSettled([
        this.track('provider', () => this.providers.join()),
      ]);
      await this.drain();
      this.joined = [...native, ...enclosing, ...providers].every(
        (result) => result.status === 'fulfilled'
      );
      const failures = [...new Set(this.failures)];
      const owned = native.find(
        (result) => result.status === 'rejected' && stillOwnsNativeWork(result.reason)
      );
      if (owned?.status === 'rejected') {
        // The barrier still owns native work: run and Root ownership stay retained.
        throw new HostRunOwnerCleanupError(
          new AggregateError(failures, 'Host memory operations failed'),
          owned.reason,
          'Host memory cleanup failed'
        );
      }
      const [first] = failures;
      if (first !== undefined) {
        // Every tail joined: the failures are the run's outcome, not a leak.
        throw new HostMemoryFailure(
          failures,
          HostMemoryStepError.wrap(this.failedStep(first) ?? 'observe', first).message
        );
      }
    });
    return this.closing;
  }
}

function isConcreteModel(model: unknown): model is MemoryLanguageModel {
  return (
    typeof model === 'object' &&
    model !== null &&
    'specificationVersion' in model &&
    ['v2', 'v3', 'v4'].includes(String(model.specificationVersion)) &&
    'doGenerate' in model &&
    typeof model.doGenerate === 'function' &&
    'doStream' in model &&
    typeof model.doStream === 'function'
  );
}

function readProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined;
}

function readModel(value: unknown): unknown {
  return readProperty(value, 'model');
}
