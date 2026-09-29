import type { AssistantStreamChunk } from 'assistant-stream';

/**
 * assistant-stream's decoder emits `message-finish` before it flushes the
 * active implicit text/reasoning part. The accumulator therefore exposes a
 * completed message while inner part streams are still draining. If the user
 * immediately sends the next turn, assistant-ui aborts that visually complete
 * run and a late append can target an already-closed text controller.
 *
 * Buffer the one terminal message marker until decoder EOF so every part-finish
 * reaches the accumulator before the UI observes completion.
 */
export function deferMessageFinishUntilFlush(
  onTerminalFinishFlushed?: () => void
): TransformStream<AssistantStreamChunk, AssistantStreamChunk> {
  let pendingFinish: AssistantStreamChunk | undefined;
  return new TransformStream<AssistantStreamChunk, AssistantStreamChunk>({
    flush(controller) {
      if (pendingFinish) {
        controller.enqueue(pendingFinish);
        onTerminalFinishFlushed?.();
      }
    },
    transform(chunk, controller) {
      if (chunk.type === 'message-finish') {
        if (pendingFinish) {
          throw new Error('Assistant data stream emitted more than one message-finish chunk.');
        }
        pendingFinish = chunk;
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
