import { isProxy } from 'node:util/types';
import type { MemoryComponent } from '@brainstrike/assistant-contract';
import type { MastraEmbeddingModel, MastraVector } from '@mastra/core/vector';
import { type LanguageModelUsage, wrapLanguageModel } from 'ai';
import { memoryFailureCauses } from './memory-failure.ts';

export type MemoryLanguageModel = Parameters<typeof wrapLanguageModel>[0]['model'];
type Model = ReturnType<typeof wrapLanguageModel>;
type StreamResult = Awaited<ReturnType<Model['doStream']>>;
type Part = StreamResult['stream'] extends ReadableStream<infer Value> ? Value : never;
type Usage = Awaited<ReturnType<Model['doGenerate']>>['usage'];
/** The memory models a run encloses. */
type ModelKind = 'observation' | 'reflection';
/** What a usage receipt was spent on: a memory model, or the embedder (BST-2226). */
type Kind = ModelKind | 'embedding';

const KIND_COMPONENTS: Readonly<Record<ModelKind, MemoryComponent>> = {
  observation: 'observer',
  reflection: 'reflector',
};

/** The memory part a failure came from, and the failure this enclosure saw. */
export interface MemoryFailureAttribution {
  readonly cause: object;
  readonly component: MemoryComponent;
}

interface Source {
  cancel(): Promise<void>;
  readonly done: Promise<void>;
}

/**
 * Run-owned public provider leaves, subordinate to the host's native enclosure.
 * This joins actual promises and original sources; it is not a native-job barrier.
 * Upstream: https://github.com/mastra-ai/mastra/tree/main/packages/memory
 */
export class MemoryProviderLifetime {
  private readonly calls = new Set<Promise<unknown>>();
  private readonly sources = new Set<Source>();
  private readonly failures: unknown[] = [];
  private readonly cancellations = new WeakSet<object>();
  /** BST-2202: the memory part each failed provider or vector call belonged to. */
  private readonly components = new WeakMap<object, MemoryComponent>();
  private closing: Promise<void> | undefined;
  private observing = false;
  private readonly onAbort = (): void => {
    for (const source of this.sources) {
      source.cancel().catch(() => undefined);
    }
  };

  constructor(
    private readonly signal: AbortSignal,
    private readonly recordUsage: (receipt: {
      readonly kind: Kind;
      readonly modelId: string;
      readonly usage: LanguageModelUsage;
    }) => Promise<void>,
    /** An embed call whose provider reported no tokens, so its spend is not recorded. */
    private readonly unreported: () => void = () => undefined
  ) {}

  private observeAbort(): void {
    if (!this.observing) {
      this.observing = true;
      this.signal.addEventListener('abort', this.onAbort, { once: true });
    }
  }

  private capture<Value>(work: Promise<Value>, providerAbort = false): Promise<Value> {
    this.calls.add(work);
    work.then(
      () => this.calls.delete(work),
      (cause: unknown) => {
        this.calls.delete(work);
        if (
          !(
            this.ownsCancellation(cause) ||
            (providerAbort && this.signal.aborted && cause === this.signal.reason)
          )
        ) {
          this.failures.push(cause);
        }
      }
    );
    return work;
  }

  /** Preserve this enclosure's cancellation provenance through native joins.
   * Incident: https://github.com/seandearnaley/brainstrike/pull/3543#issuecomment-6051062686
   * Remove this traversal when upstream preserves cancellation ownership through
   * its joined observation results and the original ownership controls pass.
   */
  ownsCancellation(cause: unknown): boolean {
    return this.ownsCancellationMember(cause, new Set());
  }

  private ownsCancellationMember(cause: unknown, ancestors: Set<object>): boolean {
    if (typeof cause !== 'object' || cause === null || isProxy(cause) || ancestors.has(cause)) {
      return false;
    }
    if (this.cancellations.has(cause)) {
      return true;
    }
    try {
      if (!(cause instanceof AggregateError)) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(cause, 'errors');
      if (!(descriptor && 'value' in descriptor)) {
        return false;
      }
      const members: unknown = descriptor.value;
      if (isProxy(members) || !Array.isArray(members)) {
        return false;
      }
      const count: unknown = Object.getOwnPropertyDescriptor(members, 'length')?.value;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
        return false;
      }
      ancestors.add(cause);
      // Require actual data members; sparse slots and accessors prove no ownership.
      for (let index = 0; index < count; index++) {
        const member = Object.getOwnPropertyDescriptor(members, String(index));
        if (
          !(member && 'value' in member && this.ownsCancellationMember(member.value, ancestors))
        ) {
          return false;
        }
      }
      return true;
    } catch {
      // Malformed trees stay original failures at the existing caller boundary.
      return false;
    } finally {
      ancestors.delete(cause);
    }
  }

  /** Record which memory part `cause` failed in; the first record sticks, cancellation has none. */
  private attribute(component: MemoryComponent, cause: unknown): void {
    if (
      typeof cause !== 'object' ||
      cause === null ||
      this.components.has(cause) ||
      (this.signal.aborted && cause === this.signal.reason) ||
      this.ownsCancellation(cause)
    ) {
      return;
    }
    this.components.set(cause, component);
  }

  /**
   * The memory part a failure came from: the first of its causes that a
   * provider or vector call of this enclosure failed with. Undefined when none did.
   */
  attribution(cause: unknown): MemoryFailureAttribution | undefined {
    for (const candidate of memoryFailureCauses(cause)) {
      const component = this.components.get(candidate);
      if (component !== undefined) {
        return { cause: candidate, component };
      }
    }
    return;
  }

  private cancellation(): Error {
    const failure = new Error('Run-owned memory embedding cancelled', {
      cause: this.signal.reason,
    });
    this.cancellations.add(failure);
    return failure;
  }

  private embeddingAdmission(): void {
    if (this.signal.aborted) {
      throw this.cancellation();
    }
    if (this.closing !== undefined) {
      throw new Error('Memory provider admission is closed');
    }
  }

  private embeddingCall<Value>(
    callerSignal: AbortSignal | undefined,
    call: (signal: AbortSignal) => PromiseLike<Value>
  ): Promise<Value> {
    this.observeAbort();
    const signal = callerSignal ? AbortSignal.any([this.signal, callerSignal]) : this.signal;
    // Capture the concrete promise, without racing it against abort. A provider
    // that ignores cancellation must physically retire before join can finish.
    return this.capture(
      Promise.resolve().then(async () => {
        this.embeddingAdmission();
        signal.throwIfAborted();
        let result: Value;
        try {
          result = await call(signal);
        } catch (cause) {
          // A coincident independent AbortError is still an inference failure.
          if (this.signal.aborted && cause === this.signal.reason) {
            throw this.cancellation();
          }
          this.attribute('embedder', cause);
          throw cause;
        }
        if (this.signal.aborted) {
          throw this.cancellation();
        }
        return result;
      })
    );
  }

  /**
   * One embed call, then its provider-reported tokens as a spend receipt
   * (BST-2226), joined like an observer call's usage.
   */
  private async embedded<Value>(modelId: string, call: Promise<Value>): Promise<Value> {
    const result = await call;
    const tokens = reportedTokens(result);
    if (tokens === undefined) {
      this.unreported();
    } else {
      await this.capture(
        this.recordUsage({ kind: 'embedding', modelId, usage: embeddingUsage(tokens) })
      );
    }
    return result;
  }

  private embeddingProxy<Model extends object>(model: Model, doEmbed: unknown): Model {
    return new Proxy(model, {
      get: (target, key) => (key === 'doEmbed' ? doEmbed : Reflect.get(target, key, target)),
    });
  }

  embedding(model: MastraEmbeddingModel<string>): MastraEmbeddingModel<string> {
    switch (model.specificationVersion) {
      case 'v1':
        return this.embeddingProxy(model, (params: Parameters<typeof model.doEmbed>[0]) =>
          this.embedded(
            model.modelId,
            this.embeddingCall(params.abortSignal, (abortSignal) =>
              model.doEmbed({ ...params, abortSignal })
            )
          )
        );
      case 'v2':
        return this.embeddingProxy(model, (params: Parameters<typeof model.doEmbed>[0]) =>
          this.embedded(
            model.modelId,
            this.embeddingCall(params.abortSignal, (abortSignal) =>
              model.doEmbed({ ...params, abortSignal })
            )
          )
        );
      case 'v3':
        return this.embeddingProxy(model, (params: Parameters<typeof model.doEmbed>[0]) =>
          this.embedded(
            model.modelId,
            this.embeddingCall(params.abortSignal, (abortSignal) =>
              model.doEmbed({ ...params, abortSignal })
            )
          )
        );
    }
  }

  /**
   * Fence native vector dispatch without reclassifying any writer rejection:
   * a rejection keeps its identity, attributed to the vector store (BST-2202).
   */
  vector(vector: MastraVector): MastraVector {
    return new Proxy(vector, {
      get: (target, key) => {
        const member: unknown = Reflect.get(target, key, target);
        if (
          typeof member === 'function' &&
          (key === 'createIndex' || key === 'query' || key === 'upsert')
        ) {
          return (...args: unknown[]) => {
            this.embeddingAdmission();
            const dispatched: unknown = Reflect.apply(member, target, args);
            return Promise.resolve(dispatched).catch((cause: unknown) => {
              this.attribute('vector-store', cause);
              throw cause;
            });
          };
        }
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
  }

  private normalizeProviderAbort(cause: unknown): unknown {
    // Qualify only the actual provider/read boundary. Storage, receipt and
    // original cancel failures never pass through this classification.
    return this.signal.aborted &&
      (cause === this.signal.reason ||
        (cause instanceof DOMException && cause.name === 'AbortError'))
      ? this.signal.reason
      : cause;
  }

  /** A memory model's own failure, attributed to its observer or reflector. */
  private providerFailure(kind: ModelKind, cause: unknown): unknown {
    const failure = this.normalizeProviderAbort(cause);
    this.attribute(KIND_COMPONENTS[kind], failure);
    return failure;
  }

  model(kind: ModelKind, model: MemoryLanguageModel): Model {
    return wrapLanguageModel({
      middleware: {
        specificationVersion: 'v4',
        transformParams: async ({ params }) => ({
          ...params,
          abortSignal: params.abortSignal
            ? AbortSignal.any([this.signal, params.abortSignal])
            : this.signal,
        }),
        wrapGenerate: async ({ doGenerate }) => {
          this.observeAbort();
          this.signal.throwIfAborted();
          if (this.closing !== undefined) {
            throw new Error('Memory provider admission is closed');
          }
          const result = await this.capture(
            Promise.resolve()
              .then(doGenerate)
              .catch((cause: unknown) => {
                throw this.providerFailure(kind, cause);
              }),
            true
          );
          await this.capture(
            this.recordUsage({ kind, modelId: model.modelId, usage: usage(result.usage) })
          );
          return result;
        },
        wrapStream: async ({ doStream }) => {
          this.observeAbort();
          this.signal.throwIfAborted();
          if (this.closing !== undefined) {
            throw new Error('Memory provider admission is closed');
          }
          const result = await this.capture(
            Promise.resolve()
              .then(doStream)
              .catch((cause: unknown) => {
                throw this.providerFailure(kind, cause);
              }),
            true
          );
          return { ...result, stream: this.source(result.stream, kind, model.modelId) };
        },
      },
      model,
    });
  }

  private source(
    stream: ReadableStream<Part>,
    kind: ModelKind,
    modelId: string
  ): ReadableStream<Part> {
    const reader = stream.getReader();
    const done = Promise.withResolvers<void>();
    done.promise.catch(() => undefined);
    let cancellation: Promise<void> | undefined;
    const source: Source = {
      cancel: () => {
        cancellation ??= this.capture(reader.cancel(this.signal.reason)).then(
          () => done.resolve(),
          (cause: unknown) => {
            done.reject(cause);
            throw cause;
          }
        );
        cancellation.catch(() => undefined);
        return cancellation;
      },
      done: done.promise,
    };
    this.sources.add(source);
    if (this.signal.aborted) {
      source.cancel().catch(() => undefined);
    }
    return new ReadableStream<Part>({
      cancel: () => source.cancel(),
      pull: async (controller) => {
        try {
          const item = await reader.read();
          if (controller.desiredSize === null) {
            return;
          }
          if (item.done) {
            done.resolve();
            controller.close();
          } else {
            if (item.value.type === 'finish') {
              await this.capture(
                this.recordUsage({ kind, modelId, usage: usage(item.value.usage) })
              );
            }
            controller.enqueue(item.value);
          }
        } catch (cause) {
          const failure = this.providerFailure(kind, cause);
          if (this.signal.aborted && failure === this.signal.reason) {
            done.resolve();
          } else {
            done.reject(failure);
          }
          if (controller.desiredSize !== null) {
            controller.error(failure);
          }
        }
      },
    });
  }

  join(): Promise<void> {
    this.closing ??= (async () => {
      while (this.calls.size > 0) {
        await Promise.allSettled([...this.calls]);
      }
      if (this.signal.aborted) {
        this.onAbort();
      }
      const sources = await Promise.allSettled([...this.sources].map((source) => source.done));
      while (this.calls.size > 0) {
        await Promise.allSettled([...this.calls]);
      }
      const failures = [
        ...this.failures,
        ...sources.flatMap((item) => (item.status === 'rejected' ? [item.reason] : [])),
      ];
      if (failures.length > 0) {
        throw new AggregateError([...new Set(failures)], 'Memory provider cleanup failed');
      }
      this.signal.removeEventListener('abort', this.onAbort);
    })();
    return this.closing;
  }
}

/** An embed result's provider-reported token count; absent when it reported none. */
function reportedTokens(result: unknown): number | undefined {
  if (typeof result !== 'object' || result === null) {
    return;
  }
  const reported: unknown = Reflect.get(result, 'usage');
  const tokens: unknown =
    typeof reported === 'object' && reported !== null ? Reflect.get(reported, 'tokens') : undefined;
  return typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0
    ? tokens
    : undefined;
}

/** An embed call's tokens as usage: all input, no output. */
function embeddingUsage(tokens: number): LanguageModelUsage {
  return {
    inputTokenDetails: {
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      noCacheTokens: tokens,
    },
    inputTokens: tokens,
    outputTokenDetails: { reasoningTokens: undefined, textTokens: undefined },
    outputTokens: 0,
    totalTokens: tokens,
  };
}

/** Preserve provider-reported totals/details; missing totals stay unknown. */
function usage(value: Usage): LanguageModelUsage {
  return {
    inputTokenDetails: {
      cacheReadTokens: value.inputTokens.cacheRead,
      cacheWriteTokens: value.inputTokens.cacheWrite,
      noCacheTokens: value.inputTokens.noCache,
    },
    inputTokens: value.inputTokens.total,
    outputTokenDetails: {
      reasoningTokens: value.outputTokens.reasoning,
      textTokens: value.outputTokens.text,
    },
    outputTokens: value.outputTokens.total,
    totalTokens:
      value.inputTokens.total === undefined || value.outputTokens.total === undefined
        ? undefined
        : value.inputTokens.total + value.outputTokens.total,
    ...(value.raw ? { raw: value.raw } : {}),
  };
}
