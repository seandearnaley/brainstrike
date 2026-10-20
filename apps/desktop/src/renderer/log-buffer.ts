import { addLogListener, LogBuffer } from '@brainstrike/logging';
import { registerBulkOperationPauseCallback } from '@brainstrike/utils/bulk-operation-context';

// Use smaller buffer with arg size limits for better memory performance
const rendererLogBuffer = new LogBuffer({
  maxArgSize: 500, // Limit arg size to 500 chars
  size: 500, // Reduced from 1000 for memory efficiency
});

const removeListener = addLogListener((record) => {
  rendererLogBuffer.push(record);
});

// Register with bulk operation context - pause during bulk ops
const unregisterBulkOp = registerBulkOperationPauseCallback(
  () => rendererLogBuffer.pause(),
  () => rendererLogBuffer.resume()
);

if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__brainstrikeRendererLogBuffer', {
    configurable: true,
    value: rendererLogBuffer,
    writable: false,
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeListener();
    unregisterBulkOp();
  });
}

export function getRendererLogBuffer(): LogBuffer {
  return rendererLogBuffer;
}

/**
 * Manually pause the log buffer during intensive operations.
 * Prefer using withBulkOperation() which handles this automatically.
 * @internal Log-buffer regressions control flush admission deterministically.
 */
export function pauseRendererLogBuffer(): void {
  rendererLogBuffer.pause();
}

/**
 * Resume the log buffer after intensive operations.
 * @internal Log-buffer regressions resume the same bounded flush queue.
 */
export function resumeRendererLogBuffer(): void {
  rendererLogBuffer.resume();
}
