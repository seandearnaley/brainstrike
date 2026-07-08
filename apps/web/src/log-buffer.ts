import { registerBulkOperationPauseCallback } from '@brainstrike/utils/bulk-operation-context';
import { LogBuffer } from '@brainstrike/utils/log-buffer';
import { addLogListener } from '@brainstrike/utils/logger';

// Use smaller buffer with arg size limits for better memory performance
const webLogBuffer = new LogBuffer({
  maxArgSize: 500, // Limit arg size to 500 chars
  size: 500, // Reduced from 1000 for memory efficiency
});

const removeListener = addLogListener((record) => {
  webLogBuffer.push(record);
});

// Register with bulk operation context - pause during bulk ops
const unregisterBulkOp = registerBulkOperationPauseCallback(
  () => webLogBuffer.pause(),
  () => webLogBuffer.resume()
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeListener();
    unregisterBulkOp();
  });
}

export function getWebLogBuffer(): LogBuffer {
  return webLogBuffer;
}

/**
 * Manually pause the log buffer during intensive operations.
 * Prefer using withBulkOperation() which handles this automatically.
 */
export function pauseWebLogBuffer(): void {
  webLogBuffer.pause();
}

/**
 * Resume the log buffer after intensive operations.
 */
export function resumeWebLogBuffer(): void {
  webLogBuffer.resume();
}
