import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import { streamText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { HostRunContext, HostRunOwner } from '../../src/ports.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type Chunk = StreamResult['stream'] extends ReadableStream<infer Value> ? Value : never;

/**
 * Controlled provider fixture for the existing HostRunOwner boundary. It runs
 * the public SDK and owns its actual provider promise and original source.
 * It is not a Memory adapter or proof that native Memory background jobs drain.
 */
export class MemoryProviderOwnershipFixture implements HostRunOwner {
  readonly providerEntered = Promise.withResolvers<AbortSignal | undefined>();
  readonly releaseProvider = Promise.withResolvers<void>();
  readonly cancelEntered = Promise.withResolvers<unknown>();
  readonly releaseCancel = Promise.withResolvers<void>();
  readonly closeEntered = Promise.withResolvers<void>();
  readonly ownerAborted = Promise.withResolvers<void>();
  readonly model: MockLanguageModelV4;
  private readonly reader: ReadableStreamDefaultReader<Chunk>;
  private readonly sdkTask: Promise<void>;
  private providerCall?: Promise<StreamResult>;
  private sourceCancellation?: Promise<void>;
  private closing?: Promise<void>;
  closeCalls = 0;

  constructor(
    readonly context: HostRunContext,
    readonly cleanupFailure?: Error
  ) {
    context.signal.addEventListener('abort', () => this.ownerAborted.resolve(), { once: true });
    const source = new ReadableStream<Chunk>({
      cancel: async (reason) => {
        this.cancelEntered.resolve(reason);
        await this.releaseCancel.promise;
        if (cleanupFailure) {
          throw cleanupFailure;
        }
      },
    });
    this.reader = source.getReader();
    const forwarded = new ReadableStream<Chunk>({
      cancel: (reason) => this.cancelSource(reason),
      pull: async (controller) => {
        const item = await this.reader.read();
        if (controller.desiredSize === null) {
          return;
        }
        if (item.done) {
          controller.close();
        } else {
          controller.enqueue(item.value);
        }
      },
    });
    this.model = new MockLanguageModelV4({
      doStream: async (options) => {
        this.providerEntered.resolve(options.abortSignal);
        // The actual leaf deliberately ignores abort until its caller releases it.
        await this.releaseProvider.promise;
        return { stream: forwarded };
      },
    });
    const middleware: LanguageModelMiddleware = {
      specificationVersion: 'v4',
      wrapStream: ({ doStream }) => {
        const actual = Promise.resolve(doStream());
        this.providerCall = actual;
        actual.catch(() => undefined);
        return actual;
      },
    };
    const model: LanguageModel = wrapLanguageModel({ middleware, model: this.model });
    const result = streamText({
      abortSignal: context.signal,
      maxRetries: 0,
      model,
      prompt: 'Scripted observer call owned by this host run.',
    });
    this.sdkTask = (async () => {
      try {
        for await (const _chunk of result.fullStream) {
          // Consume the real public SDK stream; the fixture emits no paid calls.
        }
      } catch (cause) {
        if (!context.signal.aborted) {
          throw cause;
        }
      }
    })();
    this.sdkTask.catch(() => undefined);
  }

  private cancelSource(reason: unknown): Promise<void> {
    this.sourceCancellation ??= this.reader.cancel(reason);
    this.sourceCancellation.catch(() => undefined);
    return this.sourceCancellation;
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.closing ??= (async () => {
      this.closeEntered.resolve();
      await this.providerEntered.promise;
      const actual = this.providerCall;
      if (!actual) {
        throw new Error('Observer provider leaf was not registered');
      }
      await actual;
      const joined = await Promise.allSettled([
        this.cancelSource(this.context.signal.reason),
        this.sdkTask,
      ]);
      const failures = joined.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Owned observer cleanup failed');
      }
    })();
    return this.closing;
  }
}
