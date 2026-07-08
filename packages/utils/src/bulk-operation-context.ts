/**
 * Bulk Operation Context
 *
 * Provides a context manager for bulk operations that need reduced logging overhead.
 * When active, this context:
 * - Raises the minimum log level (e.g., to WARN) to skip INFO/DEBUG logs
 * - Pauses the LogBuffer to prevent memory accumulation
 * - Enables log sampling for high-frequency operations
 *
 * Usage:
 * ```ts
 * const context = createBulkOperationContext({ level: LogLevel.WARN });
 * context.enter();
 * try {
 *   // ... bulk operations with reduced logging overhead
 * } finally {
 *   context.exit();
 * }
 * ```
 *
 * Or with the helper:
 * ```ts
 * await withBulkOperation(async () => {
 *   // ... bulk operations
 * }, { level: LogLevel.WARN });
 * ```
 */

import { LogLevel, setLogLevel } from '@brainstrike/utils/logger';

export interface BulkOperationOptions {
  /**
   * Minimum log level during bulk operations.
   * Default: LogLevel.WARN (skips DEBUG and INFO)
   */
  level?: LogLevel;

  /**
   * Callback to pause/resume external listeners (e.g., LogBuffer)
   */
  onEnter?: () => void;
  onExit?: () => void;

  /**
   * Sample rate for logs that would otherwise be skipped.
   * 0 = log nothing, 1 = log everything, 0.1 = log 10%
   * Default: 0 (no sampling, just use the level filter)
   */
  sampleRate?: number;
}

interface BulkOperationState {
  active: boolean;
  enterCount: number;
  options: Required<BulkOperationOptions>;
  previousLevel: LogLevel | null;
}

// Global state for bulk operation context
let globalState: BulkOperationState = {
  active: false,
  enterCount: 0,
  options: {
    level: LogLevel.WARN,
    onEnter: () => {},
    onExit: () => {},
    sampleRate: 0,
  },
  previousLevel: null,
};

// Registered pause/resume callbacks (e.g., from LogBuffer)
const pauseCallbacks = new Set<() => void>();
const resumeCallbacks = new Set<() => void>();

/**
 * Register a pause callback to be called when bulk operation starts.
 * Returns an unregister function.
 */
export function registerBulkOperationPauseCallback(
  onPause: () => void,
  onResume: () => void
): () => void {
  pauseCallbacks.add(onPause);
  resumeCallbacks.add(onResume);

  return () => {
    pauseCallbacks.delete(onPause);
    resumeCallbacks.delete(onResume);
  };
}

/**
 * Check if a bulk operation is currently active.
 */
export function isBulkOperationActive(): boolean {
  return globalState.active;
}

/**
 * Get the current bulk operation level (or null if not in bulk mode).
 */
export function getBulkOperationLevel(): LogLevel | null {
  return globalState.active ? globalState.options.level : null;
}

/**
 * Get the sample rate for the current bulk operation.
 */
export function getBulkOperationSampleRate(): number {
  return globalState.active ? globalState.options.sampleRate : 1;
}

export interface BulkOperationContext {
  /**
   * Enter the bulk operation context.
   * Can be called multiple times (reference counted).
   */
  enter: () => void;

  /**
   * Exit the bulk operation context.
   * Only restores original state when all enter() calls are matched.
   */
  exit: () => void;

  /**
   * Check if this context is currently active.
   */
  isActive: () => boolean;
}

/**
 * Create a bulk operation context.
 */
export function createBulkOperationContext(options?: BulkOperationOptions): BulkOperationContext {
  const resolvedOptions: Required<BulkOperationOptions> = {
    level: options?.level ?? LogLevel.WARN,
    onEnter: options?.onEnter ?? (() => {}),
    onExit: options?.onExit ?? (() => {}),
    sampleRate: options?.sampleRate ?? 0,
  };

  return {
    enter() {
      globalState.enterCount++;

      if (globalState.enterCount === 1) {
        // First entry - save state and activate
        globalState.active = true;
        globalState.options = resolvedOptions;

        // Notify all registered pause callbacks
        for (const callback of pauseCallbacks) {
          try {
            callback();
          } catch {
            // Ignore callback errors
          }
        }

        // Call custom onEnter
        resolvedOptions.onEnter();

        // Raise log level
        setLogLevel(resolvedOptions.level);
      }
    },

    exit() {
      if (globalState.enterCount === 0) {
        return; // Already exited
      }

      globalState.enterCount--;

      if (globalState.enterCount === 0) {
        // Last exit - restore state
        globalState.active = false;

        // Notify all registered resume callbacks
        for (const callback of resumeCallbacks) {
          try {
            callback();
          } catch {
            // Ignore callback errors
          }
        }

        // Call custom onExit
        resolvedOptions.onExit();

        // Restore previous level (INFO is a safe default)
        setLogLevel(LogLevel.INFO);
      }
    },

    isActive() {
      return globalState.active && globalState.enterCount > 0;
    },
  };
}

/**
 * Execute a function within a bulk operation context.
 * Automatically enters and exits the context.
 */
export async function withBulkOperation<T>(
  fn: () => Promise<T>,
  options?: BulkOperationOptions
): Promise<T> {
  const context = createBulkOperationContext(options);
  context.enter();
  try {
    return await fn();
  } finally {
    context.exit();
  }
}

/**
 * Synchronous version of withBulkOperation.
 */
export function withBulkOperationSync<T>(fn: () => T, options?: BulkOperationOptions): T {
  const context = createBulkOperationContext(options);
  context.enter();
  try {
    return fn();
  } finally {
    context.exit();
  }
}

/**
 * Reset bulk operation state (useful for testing).
 */
export function resetBulkOperationState(): void {
  globalState = {
    active: false,
    enterCount: 0,
    options: {
      level: LogLevel.WARN,
      onEnter: () => {},
      onExit: () => {},
      sampleRate: 0,
    },
    previousLevel: null,
  };
}
