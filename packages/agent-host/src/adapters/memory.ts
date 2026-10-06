import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import type { LanguageModelMiddleware, LanguageModelUsage } from 'ai';
import type { HostRunContext, HostRunOwner } from '../ports.js';
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
  /**
   * Required enclosing owner: join actual provider/source/storage/hook work and
   * native async jobs, including work Memory.settled() does not expose. Passing
   * Memory.settled itself here does not meet this capability's contract.
   */
  joinNativeLifetime(): Promise<void>;
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
 * Native Memory 1.32.1 does not expose a complete physical lifecycle barrier.
 * The injected enclosing lifetime is essential to close/reset safety; native
 * settlement is only one participant. Native deleteThread is not a strict purge
 * authority. Root admission, derived cleanup and lease retention remain host-owned.
 * Upstream primitive: https://github.com/mastra-ai/mastra/tree/main/packages/memory
 * Remove the enclosing lifetime requirement only when the unmodified public
 * barrier joins all native tails and propagates failures and owner cancellation.
 */
export class HostMemory implements HostRunOwner {
  private readonly memory: Memory;
  private readonly providers: MemoryProviderLifetime;
  private readonly messageList: MessageList;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failures: unknown[] = [];
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
    this.memory = new Memory(native);
    this.messageList = new MessageList({
      resourceId: identity.resourceId,
      threadId: identity.threadId,
    });
  }

  private track<Value>(
    operation: () => Promise<Value>,
    providerCancellation = false
  ): Promise<Value> {
    const work = Promise.resolve().then(operation);
    this.pending.add(work);
    work.then(
      () => this.pending.delete(work),
      (cause: unknown) => {
        this.pending.delete(work);
        if (
          !(
            providerCancellation &&
            this.identity.signal.aborted &&
            cause === this.identity.signal.reason
          )
        ) {
          this.failures.push(cause);
        }
      }
    );
    return work;
  }

  private admit<Value>(
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
    return this.track(operation, providerCancellation);
  }

  private identifiers(): { resourceId: string; threadId: string } {
    return { resourceId: this.identity.resourceId, threadId: this.identity.threadId };
  }

  /** Current-turn committed input only; native context selects the retained history. */
  beginTurn(committedMessages: readonly MastraDBMessage[]): Promise<NativeContext> {
    if (this.closing || this.identity.signal.aborted) {
      return this.admit(async () => this.memory.getContext(this.identifiers()));
    }
    if (this.beginning) {
      return this.beginning;
    }
    this.beginning = this.admit(async () => {
      this.messageList.add([...committedMessages], 'memory');
      const engine = await this.memory.omEngine;
      if (engine) {
        this.turn = engine.beginTurn({ ...this.identifiers(), messageList: this.messageList });
        await this.turn.start({
          getContext: (options) => this.track(() => this.memory.getContext(options)),
          persistMessages: (messages) => this.track(() => this.memory.persistMessages(messages)),
        });
      }
      return this.memory.getContext(this.identifiers());
    }, true);
    return this.beginning;
  }

  prepareStep(stepNumber: number): Promise<HostMemoryStep> {
    return this.admit(async () => {
      if (!this.beginning) {
        throw new Error('Host memory turn has not begun');
      }
      await this.beginning;
      const observation = await this.turn?.step(stepNumber).prepare();
      const [context, workingMemory] = await Promise.all([
        this.track(() => this.memory.getContext(this.identifiers())),
        this.track(() => this.memory.getWorkingMemory(this.identifiers())),
      ]);
      return {
        context,
        messages: context.messages,
        observation,
        workingMemory,
      };
    }, true);
  }

  /** Only after the host committed the SDK step; preserve its stable projection IDs. */
  commitStep(committedMessages: readonly MastraDBMessage[]): Promise<void> {
    return this.admit(async () => {
      this.messageList.add([...committedMessages], 'response');
      // Preserve the library's semantic indexing and working-memory processing;
      // raw persistMessages is only the public turn's sealed-message projection.
      await this.memory.saveMessages({ messages: [...committedMessages] });
    });
  }

  recall(options: Omit<Parameters<Memory['recall']>[0], 'threadId'>): ReturnType<Memory['recall']> {
    return this.admit(() => this.memory.recall({ ...options, threadId: this.identity.threadId }));
  }

  getWorkingMemory(): ReturnType<Memory['getWorkingMemory']> {
    return this.admit(() => this.memory.getWorkingMemory(this.identifiers()));
  }

  updateWorkingMemory(workingMemory: string): ReturnType<Memory['updateWorkingMemory']> {
    return this.admit(() =>
      this.memory.updateWorkingMemory({ ...this.identifiers(), workingMemory })
    );
  }

  recordPrompt(request: ProviderRequest): Promise<void> {
    return this.admit(() => this.capabilities.recordPrompt(this.identity, request));
  }

  recordObserverUsage(
    receipt: Parameters<HostMemoryCapabilities['recordObserverUsage']>[1]
  ): Promise<void> {
    // Already-admitted provider tails may arrive during Stop; the host ledger
    // keeps their reported spend. These writes must remain joined during close.
    if (this.joined) {
      return Promise.reject(new Error('Host memory lifetime is already joined'));
    }
    return this.track(() => this.capabilities.recordObserverUsage(this.identity, receipt));
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      // Owner cancellation reaches actual provider/source leaves immediately,
      // before foreground joins. The enclosing owner may also need to cancel
      // native work before the foreground operation can finish.
      const abortJoin = this.identity.signal.aborted
        ? Promise.resolve().then(() => this.capabilities.joinNativeLifetime())
        : undefined;
      abortJoin?.catch(() => undefined);
      if (this.identity.signal.aborted) {
        await Promise.allSettled([this.track(() => this.providers.join())]);
      }
      await this.drain();
      if (this.turn && !this.turn.ended) {
        const turn = this.turn;
        await Promise.allSettled([this.track(() => turn.end())]);
      }
      const joined = await Promise.allSettled([
        this.track(() => this.memory.settled()),
        this.track(() => abortJoin ?? this.capabilities.joinNativeLifetime()),
      ]);
      const providers = await Promise.allSettled([this.track(() => this.providers.join())]);
      await this.drain();
      this.joined = [...joined, ...providers].every((result) => result.status === 'fulfilled');
      if (this.failures.length > 0) {
        throw new AggregateError([...new Set(this.failures)], 'Host memory cleanup failed');
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
