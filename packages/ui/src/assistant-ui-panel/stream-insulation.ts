import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('AssistantStreamInsulation');

/**
 * BST-704: assistant-stream's decoder/tool pipeline hand-rolls nested stream
 * controllers (merge streams, tool-call sub-streams) whose settlement paths
 * (`setResponse`, detached part-finish continuations) enqueue without a
 * cancellation guard. If downstream cancellation or an upstream abort error
 * ever propagates INTO that pipeline mid-settlement, the late enqueue rejects
 * with an unhandled "Cannot enqueue a chunk into a readable stream that is
 * closed" TypeError (upstream fix pending in assistant-ui/assistant-ui#5045).
 *
 * This boundary makes those states unreachable instead of racing them:
 *
 * - The pipeline reads from a GUARDED byte source. An expected abort of the
 *   transport read (the run's AbortSignal fired) is translated into a clean
 *   end-of-stream, so the pipeline always shuts down through its normal
 *   close/flush path. Non-abort transport faults still propagate as errors.
 * - The consumer reads through a cancellation FIREWALL. Cancelling the
 *   returned stream (supersede / cancel / detach) never cancels the pipeline;
 *   it cancels the byte source and drains the pipeline to its natural end in
 *   the background, so every in-flight settlement lands in an open stream.
 *
 * Both directions are structural, not timing-based: no third-party transform
 * ever observes downstream closure or an aborted upstream while it can still
 * settle. Real faults stay loud — pre-cancellation pipeline errors reach the
 * consumer, and post-cancellation non-abort drain failures are logged with
 * diagnostic context.
 */
export interface InsulatedAssistantStreamPipelineOptions<T> {
  /** The run's abort signal; an aborted transport read is an expected end of stream. */
  readonly abortSignal: AbortSignal;
  /** Raw HTTP response body. The only stream external teardown may reach. */
  readonly body: ReadableStream<Uint8Array>;
  /** Composes the decode/transform pipeline over the guarded byte source. */
  readonly buildPipeline: (source: ReadableStream<Uint8Array>) => ReadableStream<T>;
}

const isAbortShapedError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

export function insulateAssistantStreamPipeline<T>({
  abortSignal,
  body,
  buildPipeline,
}: InsulatedAssistantStreamPipelineOptions<T>): ReadableStream<T> {
  const byteReader = body.getReader();

  const guardedSource = new ReadableStream<Uint8Array>({
    cancel(reason: unknown) {
      // Reached only when the pipeline itself tears down (e.g. a decode fault
      // aborts the internal pipes); release the transport.
      return byteReader.cancel(reason).catch(() => undefined);
    },
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await byteReader.read();
      } catch (error) {
        if (!abortSignal.aborted) {
          controller.error(error);
          return;
        }
        if (!isAbortShapedError(error)) {
          logger.warn('Assistant transport read failed after abort; ending stream', { error });
        }
        controller.close();
        return;
      }
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
  });

  const pipelineReader = buildPipeline(guardedSource).getReader();
  let consumerCancelled = false;

  const drainAfterCancel = async (reason: unknown): Promise<void> => {
    try {
      await byteReader.cancel(reason);
    } catch {
      // The transport read may already be errored/cancelled; nothing to release.
    }
    try {
      let result = await pipelineReader.read();
      while (!result.done) {
        result = await pipelineReader.read();
      }
    } catch (error) {
      if (abortSignal.aborted && isAbortShapedError(error)) {
        return;
      }
      logger.error('Assistant stream pipeline failed while draining after cancellation', {
        error,
      });
    }
  };

  return new ReadableStream<T>({
    cancel(reason: unknown) {
      consumerCancelled = true;
      // Detached by design: the consumer must not block on (or observe) the
      // background drain; its own run already has a terminal outcome.
      void drainAfterCancel(reason);
    },
    async pull(controller) {
      let result: ReadableStreamReadResult<T>;
      try {
        result = await pipelineReader.read();
      } catch (error) {
        if (!consumerCancelled) {
          controller.error(error);
        }
        return;
      }
      if (consumerCancelled) {
        // A read resolved after cancel(); the drain loop owns the rest.
        return;
      }
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
  });
}
