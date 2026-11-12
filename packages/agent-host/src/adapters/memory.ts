import {
  type BoundaryFailure,
  BoundaryFailureError,
  memoryConfigurationError,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import { noopObserve } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import type { LanguageModelMiddleware, LanguageModelUsage } from 'ai';
import { correlationIdFor } from '../failure-correlation.ts';
import type { HostMemoryCycle, HostRunContext, HostRunOwner } from '../ports.ts';
import { HostRunOwnerCleanupError, HostRunOwnerFailure } from '../run-admission.ts';
import { classifyMemoryFailure, memoryFailureCauses } from './memory-failure.ts';
import { type MemoryLanguageModel, MemoryProviderLifetime } from './memory-provider-lifetime.ts';

type MemoryConfig = NonNullable<ConstructorParameters<typeof Memory>[0]>;
type Engine = NonNullable<Awaited<Memory['omEngine']>>;
type Turn = ReturnType<Engine['beginTurn']>;
type PreparedStep = Awaited<ReturnType<ReturnType<Turn['step']>['prepare']>>;
type NativeContext = Awaited<ReturnType<Memory['getContext']>>;
type ProviderRequest = Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0]['params'];
type ObservationConfig = Extract<
  NonNullable<MemoryConfig['options']>['observationalMemory'],
  object
>;
type CycleHooks = NonNullable<ObservationConfig['hooks']>;
type CycleStart = Parameters<NonNullable<CycleHooks['onObservationStart']>>[0];
type CycleEnd = Parameters<NonNullable<CycleHooks['onObservationEnd']>>[0];

const logger = createLogger('AgentHostMemory');

/** The lifecycle hooks the host installs to commit each cycle (BST-2224). */
const CYCLE_HOOKS = [
  'onObservationStart',
  'onObservationEnd',
  'onReflectionStart',
  'onReflectionEnd',
] as const satisfies readonly (keyof CycleHooks)[];

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The token counts a cycle reported; absent when it made no model call. */
function cycleUsage(usage: CycleEnd['usage']): HostMemoryCycle['usage'] {
  const counts = {
    inputTokens: tokenCount(usage?.inputTokens),
    outputTokens: tokenCount(usage?.outputTokens),
    totalTokens: tokenCount(usage?.totalTokens),
  };
  const reported = Object.entries(counts).filter(([, count]) => count !== undefined);
  return reported.length === 0 ? undefined : Object.fromEntries(reported);
}

/** A run's identity for native Memory, which reads committed history only through its storage domain. */
export interface HostMemoryIdentity extends Omit<HostRunContext, 'readCommittedRows'> {
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
  /**
   * The observer's catalog `provider::model`, which its usage is priced and
   * attributed under. Required whenever observational memory is on.
   */
  readonly observerModelId?: string;
  /**
   * Each observation and reflection cycle's facts (BST-2224), from Mastra's
   * documented lifecycle hooks. Without it no cycle hooks are installed.
   */
  recordMemoryCycle?(identity: HostMemoryIdentity, cycle: HostMemoryCycle): Promise<void>;
  /**
   * Actual observer and reflector usage (BST-2226) with the catalog model it
   * is priced under, for the existing usage ledger.
   */
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
  | 'save'
  | 'working memory'
  | 'tool'
  | 'accounting'
  | 'provider';

/**
 * A memory operation failed; its run fails with the step's typed failure
 * (BST-2202). The raw failure stays the cause, logged under the fault's
 * correlation id; `step` names the memory step in that record.
 */
export class HostMemoryStepError extends BoundaryFailureError {
  readonly step: HostMemoryStepName;

  private constructor(step: HostMemoryStepName, failure: BoundaryFailure, cause: unknown) {
    super(failure, { cause });
    this.step = step;
    this.name = 'HostMemoryStepError';
  }

  /**
   * The first labelled step is kept when a failure crosses nested operations.
   * A fault takes its correlation id here, so every boundary that reports this
   * failure names the same id.
   */
  static wrap(
    step: HostMemoryStepName,
    cause: unknown,
    failure: BoundaryFailure
  ): HostMemoryStepError {
    if (cause instanceof HostMemoryStepError) {
      return cause;
    }
    return new HostMemoryStepError(
      step,
      failure.kind === 'fault' && failure.correlationId === undefined
        ? { ...failure, correlationId: correlationIdFor(cause) }
        : failure,
      cause
    );
  }
}

/**
 * Every memory tail joined, but these operations failed: the run's outcome,
 * not a leak. The original failures are retained; the first one's typed step
 * failure is the outcome's.
 */
export class HostMemoryFailure extends HostRunOwnerFailure {
  /** The memory step the outcome's failure came from, named in its diagnostic record. */
  readonly step: HostMemoryStepName;
  constructor(failures: readonly unknown[], outcome: HostMemoryStepError) {
    super(failures, outcome.message, outcome.failure);
    this.name = 'HostMemoryFailure';
    this.step = outcome.step;
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
 * As Mastra documents (`Memory.settled()`), its buffered observation continues
 * after the run's answer: `endTurn` joins the foreground work before the run
 * ends, and `close` joins the native background work after it.
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
  /** Each failure's typed step failure, so every report of it is the same one. */
  private readonly stepFailures = new WeakMap<object, HostMemoryStepError>();
  private turn: Turn | undefined;
  private beginning: Promise<NativeContext> | undefined;
  /** Admitted work drained and the native turn ended, once. */
  private ending: Promise<void> | undefined;
  private turnOutcome: Promise<void> | undefined;
  /**
   * Failures already made visible, with their causes: the run's outcome
   * (`endTurn`). `close` reports only later ones.
   */
  private readonly reported = new Set<unknown>();
  private closing: Promise<void> | undefined;
  private joined = false;
  private readonly observerModelId: string | undefined;

  readonly identity: HostMemoryIdentity;
  private readonly capabilities: HostMemoryCapabilities;

  constructor(identity: HostMemoryIdentity, capabilities: HostMemoryCapabilities) {
    this.identity = identity;
    this.capabilities = capabilities;
    this.observerModelId = capabilities.observerModelId;
    this.providers = new MemoryProviderLifetime(identity.signal, (receipt) =>
      this.recordObserverUsage(receipt)
    );
    let native = capabilities.native;
    const observation = native.options?.observationalMemory;
    if (observation && readProperty(observation, 'enabled') !== false) {
      const sharedModel = readModel(observation);
      const observer = readModel(readProperty(observation, 'observation')) ?? sharedModel;
      const reflector = readModel(readProperty(observation, 'reflection')) ?? sharedModel;
      // ADR-0013 and the existing memory credential boundary: descriptors and
      // routing strings cannot trigger Mastra's implicit credential resolution.
      if (!(isConcreteModel(observer) && isConcreteModel(reflector))) {
        throw memoryConfigurationError(
          'Observational memory requires resolved concrete observer and reflector models'
        );
      }
      if (!capabilities.observerModelId) {
        throw memoryConfigurationError(
          'Observational memory requires its observer catalog model id'
        );
      }
      if (typeof observation === 'object') {
        native = {
          ...native,
          options: {
            ...native.options,
            observationalMemory: this.enclosedObservation(observation, observer, reflector),
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

  /**
   * The run's observational memory: its observer and reflector inside the
   * provider enclosure, the run's signal, and the host's lifecycle hooks
   * beside the transform hooks it was configured with.
   */
  private enclosedObservation(
    observation: ObservationConfig,
    observer: MemoryLanguageModel,
    reflector: MemoryLanguageModel
  ): ObservationConfig {
    const configured = observation.hooks ?? {};
    if (CYCLE_HOOKS.some((name) => configured[name] !== undefined)) {
      throw memoryConfigurationError('Observational memory lifecycle hooks are host-owned');
    }
    return {
      ...observation,
      abortSignal: this.identity.signal,
      ...(this.capabilities.recordMemoryCycle
        ? { hooks: { ...configured, ...this.cycleHooks() } }
        : {}),
      model: undefined,
      observation: {
        ...observation.observation,
        model: this.providers.model('observation', observer),
      },
      reflection: {
        ...observation.reflection,
        model: this.providers.model('reflection', reflector),
      },
    };
  }

  /**
   * Mastra's documented lifecycle hooks, which commit each cycle's facts
   * (BST-2224). Mastra tracks a hook's promise as its background work, so
   * `settled()` joins the commit before this owner closes.
   */
  private cycleHooks(): CycleHooks {
    // Start times per kind and trigger, oldest first: cycles of one kind end in order.
    const started = new Map<string, number[]>();
    const key = (kind: HostMemoryCycle['kind'], trigger: string | undefined) =>
      `${kind}:${trigger ?? ''}`;
    const start = (kind: HostMemoryCycle['kind']) => (info: CycleStart) => {
      const list = started.get(key(kind, info?.trigger)) ?? [];
      list.push(performance.now());
      started.set(key(kind, info?.trigger), list);
    };
    const end = (kind: HostMemoryCycle['kind']) => (result: CycleEnd) =>
      this.recordCycle(kind, started.get(key(kind, result.trigger))?.shift(), result);
    return {
      onObservationEnd: end('observation'),
      onObservationStart: start('observation'),
      onReflectionEnd: end('reflection'),
      onReflectionStart: start('reflection'),
    };
  }

  /**
   * One cycle's committed facts. A failed cycle names its typed memory
   * failure, and its cause is logged under that failure's reference: Mastra
   * reports a buffered cycle's failure only to this hook.
   */
  private recordCycle(
    kind: HostMemoryCycle['kind'],
    startedAt: number | undefined,
    result: CycleEnd
  ): Promise<void> {
    const record = this.capabilities.recordMemoryCycle;
    if (!record) {
      return Promise.resolve();
    }
    if (this.joined) {
      return Promise.reject(new Error('Host memory lifetime is already joined'));
    }
    const { error, trigger } = result;
    const cancelled = error !== undefined && this.expectedCancellation(error, true);
    const failure =
      error === undefined || cancelled ? undefined : this.stepFailure('observe', error).failure;
    if (failure) {
      logger.error('Memory cycle failed', {
        cause: error,
        code: failure.code,
        ...(failure.correlationId === undefined ? {} : { correlationId: failure.correlationId }),
        kind,
        runId: this.identity.runId,
        threadId: this.identity.threadId,
        ...(trigger === undefined ? {} : { trigger }),
      });
    }
    const usage = cycleUsage(result.usage);
    const cycle: HostMemoryCycle = {
      ...(startedAt === undefined
        ? {}
        : { durationMs: Math.max(0, Math.round(performance.now() - startedAt)) }),
      ...(failure
        ? {
            failure: {
              code: failure.code,
              ...(failure.correlationId === undefined
                ? {}
                : { correlationId: failure.correlationId }),
            },
          }
        : {}),
      kind,
      outcome: cancelled ? 'cancelled' : failure ? 'failed' : 'completed',
      ...(trigger === undefined ? {} : { trigger }),
      ...(usage ? { usage } : {}),
    };
    return this.track('accounting', () => record(this.identity, cycle));
  }

  private expectedCancellation(cause: unknown, providerCancellation: boolean): boolean {
    return (
      providerCancellation && this.identity.signal.aborted && cause === this.identity.signal.reason
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
    if (this.closing || this.ending) {
      return Promise.reject(new Error('Host memory admission is closed'));
    }
    try {
      this.identity.signal.throwIfAborted();
    } catch (cause) {
      return Promise.reject(cause);
    }
    return this.track(step, operation, providerCancellation);
  }

  /** The memory step a failure this run retained came from, for its run detail. */
  failedStep(cause: unknown): HostMemoryStepName | undefined {
    return typeof cause === 'object' && cause !== null ? this.failureSteps.get(cause) : undefined;
  }

  /**
   * A failure's typed memory step failure (BST-2202), once per failure: the
   * step that reports it and the outcome that joins it name the same failure
   * and correlation id.
   */
  stepFailure(step: HostMemoryStepName, cause: unknown): HostMemoryStepError {
    // A failure that carries one already reported (a provider join re-reporting
    // the failure a step surfaced) is that same failure.
    for (const candidate of memoryFailureCauses(cause)) {
      const known = this.stepFailures.get(candidate);
      if (known) {
        return known;
      }
    }
    const failedStep = this.failedStep(cause) ?? step;
    const failure = HostMemoryStepError.wrap(
      failedStep,
      cause,
      classifyMemoryFailure(failedStep, cause, {
        attribution: (failed) => this.providers.attribution(failed),
        ...(this.observerModelId === undefined ? {} : { observerModelId: this.observerModelId }),
      })
    );
    if (typeof cause === 'object' && cause !== null) {
      this.stepFailures.set(cause, failure);
    }
    return failure;
  }

  private identifiers(): { resourceId: string; threadId: string } {
    return { resourceId: this.identity.resourceId, threadId: this.identity.threadId };
  }

  /** Current-turn committed input only; native context selects the retained history. */
  beginTurn(committedMessages: readonly MastraDBMessage[]): Promise<NativeContext> {
    if (this.closing || this.identity.signal.aborted) {
      return this.admit('open', async () => this.memory.getContext(this.identifiers()));
    }
    if (this.beginning !== undefined) {
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

  /**
   * Only after the host committed the SDK step; preserve its stable projection IDs.
   *
   * A run cancelled before its save begins (a Stop, or the app quitting just
   * after a reply, BST-2478) leaves nothing unsaved: the step is already in the
   * canonical transcript, and with no vector store Memory keeps no copy of it
   * (its storage only checks the committed rows, BST-2428). A save that began
   * and then failed, even with the run's own abort reason, stays a failure, and
   * so does a cancelled save that would have embedded the step.
   */
  commitStep(committedMessages: readonly MastraDBMessage[]): Promise<void> {
    if (
      !(this.closing || this.ending) &&
      this.identity.signal.aborted &&
      this.memory.vector === undefined
    ) {
      return Promise.resolve();
    }
    return this.admit('save', async () => {
      // Immutable committed segments retain their existing row addresses. The
      // list already holds earlier steps' segments, and re-adding one that
      // Memory sealed would append a copy under a fresh ID.
      const listed = new Set(this.messageList.get.all.db().map((message) => message.id));
      this.messageList.add(
        committedMessages.filter((message) => !listed.has(message.id)),
        'response',
        { merge: false }
      );
      // Preserve the library's working-memory processing; raw persistMessages
      // is only the public turn's sealed-message projection.
      await this.memory.saveMessages({ messages: [...committedMessages] });
    });
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
   *
   * The vendor tool's own failure answers its call, so the model sees it; it
   * is never the turn's outcome.
   */
  async executeTool(name: string, input: unknown, toolCallId: string): Promise<unknown> {
    const outcome = await this.admit('tool', async () => {
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
      try {
        return { value: await tool.execute(input, context) };
      } catch (cause) {
        return { failure: cause };
      }
    });
    if ('failure' in outcome) {
      throw outcome.failure;
    }
    return outcome.value;
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
    const modelId = this.observerModelId;
    if (!modelId) {
      return Promise.reject(
        new Error('Observer usage arrived without an observer catalog model id')
      );
    }
    // The SDK reports its own model id; the ledger prices the catalog id.
    return this.track('accounting', () =>
      this.capabilities.recordObserverUsage(this.identity, { ...receipt, modelId })
    );
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private endingTurn(): Promise<void> {
    this.ending ??= Promise.resolve().then(async () => {
      await this.drain();
      if (this.turn && !this.turn.ended) {
        const turn = this.turn;
        await Promise.allSettled([this.track('observe', () => turn.end())]);
      }
    });
    return this.ending;
  }

  /** The failure itself (an object or not), then each of its causes. */
  private markReported(failure: unknown): void {
    this.reported.add(failure);
    for (const candidate of memoryFailureCauses(failure)) {
      this.reported.add(candidate);
    }
  }

  /** Already visible: itself, or a provider join that repeats only visible failures. */
  private wasReported(cause: unknown): boolean {
    return (
      this.reported.has(cause) ||
      (cause instanceof AggregateError &&
        cause.errors.length > 0 &&
        cause.errors.every((member) => this.wasReported(member)))
    );
  }

  /** Every listed failure joined: the outcome, naming the first failure's step. */
  private joinedFailure(failures: readonly unknown[]): HostMemoryFailure | undefined {
    const [first] = failures;
    if (first === undefined) {
      return;
    }
    return new HostMemoryFailure(failures, this.stepFailure('observe', first));
  }

  /**
   * The run's foreground memory work: every admitted operation and the native
   * turn end. Native buffered observation and reflection keep running; `close`
   * joins them. A failure retained so far is the run's outcome.
   */
  endTurn(): Promise<void> {
    this.turnOutcome ??= this.endingTurn().then(() => {
      const failures = [...new Set(this.failures)];
      for (const failure of failures) {
        this.markReported(failure);
      }
      const failure = this.joinedFailure(failures);
      if (failure) {
        throw failure;
      }
    });
    return this.turnOutcome;
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      // The run signal reaches native work and raw provider/source leaves as
      // soon as Stop aborts it, independently of this foreground drain.
      if (this.identity.signal.aborted) {
        await Promise.allSettled([this.track('provider', () => this.providers.join())]);
      }
      await this.endingTurn();
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
      // Every tail joined: the failures are an outcome, not a leak. Those
      // already reported are the run's; later ones are its settlement's.
      const failure = this.joinedFailure(failures.filter((cause) => !this.wasReported(cause)));
      if (failure) {
        throw failure;
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
