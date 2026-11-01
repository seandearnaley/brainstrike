import type { MemoryComponent } from '@brainstrike/assistant-contract';
import { type LanguageModelUsage, wrapLanguageModel } from 'ai';
import { memoryFailureCauses } from './memory-failure.ts';

export type MemoryLanguageModel = Parameters<typeof wrapLanguageModel>[0]['model'];
type Model = ReturnType<typeof wrapLanguageModel>;
type StreamResult = Awaited<ReturnType<Model['doStream']>>;
type Part = StreamResult['stream'] extends ReadableStream<infer Value> ? Value : never;
type Usage = Awaited<ReturnType<Model['doGenerate']>>['usage'];
/** The memory models a run encloses. */
type ModelKind = 'observation' | 'reflection';

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
  /** BST-2202: the memory part each failed provider call belonged to. */
  private readonly components = new WeakMap<object, MemoryComponent>();
  private closing: Promise<void> | undefined;
  private observing = false;
  private readonly onAbort = (): void => {
    for (const source of this.sources) {
      source.cancel().catch(() => undefined);
    }
  };

  private readonly signal: AbortSignal;
  private readonly recordUsage: (receipt: {
    readonly kind: ModelKind;
    readonly modelId: string;
    readonly usage: LanguageModelUsage;
  }) => Promise<void>;

  constructor(
    signal: AbortSignal,
    recordUsage: (receipt: {
      readonly kind: ModelKind;
      readonly modelId: string;
      readonly usage: LanguageModelUsage;
    }) => Promise<void>
  ) {
    this.signal = signal;
    this.recordUsage = recordUsage;
  }

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
        if (!(providerAbort && this.signal.aborted && cause === this.signal.reason)) {
          this.failures.push(cause);
        }
      }
    );
    return work;
  }

  /** Record which memory part `cause` failed in; the first record sticks, cancellation has none. */
  private attribute(component: MemoryComponent, cause: unknown): void {
    if (
      typeof cause !== 'object' ||
      cause === null ||
      this.components.has(cause) ||
      (this.signal.aborted && cause === this.signal.reason)
    ) {
      return;
    }
    this.components.set(cause, component);
  }

  /**
   * The memory part a failure came from: the first of its causes that a
   * provider call of this enclosure failed with. Undefined when none did.
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
