/**
 * @module pipeline/pipeline-controller
 *
 * Pause/resume/cancel controls for the indexing pipeline.
 *
 * This module provides a state machine for controlling pipeline execution,
 * enabling users to pause, resume, or cancel long-running indexing operations.
 *
 * ## State Machine
 *
 * ```
 *           ┌─────────────────────────────────────────┐
 *           │                                         │
 *           v                                         │
 *      ┌────────┐  start()  ┌─────────┐  pause()  ┌───────┐
 *      │  idle  │ ───────►  │ running │ ───────►  │paused │
 *      └────────┘           └─────────┘           └───────┘
 *           ▲                    │  │                 │
 *           │                    │  │ resume()        │
 *           │                    │  └─────────────────┘
 *           │   complete()       │
 *           │   ┌────────────────┘
 *           │   │       │ cancel()
 *           │   v       v
 *      ┌──────────┐ ┌──────────┐
 *      │ complete │ │ canceled │
 *      └──────────┘ └──────────┘
 *           │            │
 *           │   reset()  │
 *           └────────────┴──────────────► idle
 * ```
 *
 * ## Design Principles
 *
 * 1. **Waiter Pattern**: Pause blocks new work via promise waiters (from workerpool pattern)
 * 2. **AbortController**: Cancel triggers AbortSignal for graceful termination
 * 3. **Event Callbacks**: State changes emit to allow UI updates
 * 4. **Idempotent Transitions**: Multiple pause/resume calls are safe
 *
 * @example
 * ```typescript
 * const controller = createPipelineController({
 *   onStateChange: (state) => console.log('State:', state),
 * });
 *
 * controller.start();
 * // ... pipeline operations check controller.signal and await controller.waitIfPaused()
 *
 * controller.pause();  // Blocks new work
 * controller.resume(); // Resumes blocked work
 * controller.cancel(); // Aborts and transitions to canceled
 * ```
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Pipeline execution states.
 */
export type PipelineState = 'idle' | 'running' | 'paused' | 'canceled' | 'complete' | 'error';

/**
 * State change callback signature.
 */
export type StateChangeCallback = (
  newState: PipelineState,
  previousState: PipelineState,
  metadata?: StateChangeMetadata
) => void;

/**
 * Metadata for state changes.
 */
export interface StateChangeMetadata {
  /** Duration in current state before transition (ms) */
  durationInPreviousStateMs?: number;
  /** Error message if transitioning to error state */
  error?: string;
  /** Timestamp of state change */
  timestamp: string;
}

/**
 * Configuration for creating a pipeline controller.
 */
export interface PipelineControllerConfig {
  /** Initial state (defaults to 'idle') */
  initialState?: PipelineState;
  /** Callback invoked on state changes */
  onStateChange?: StateChangeCallback;
}

/**
 * Pipeline controller interface.
 */
export interface PipelineController {
  /**
   * Whether the pipeline can be canceled.
   */
  readonly canCancel: boolean;

  /**
   * Cancel the pipeline. Transitions to canceled state.
   * Triggers AbortSignal and unblocks all waiters.
   * @returns true if state changed, false if already canceled or invalid transition
   */
  cancel: () => boolean;

  /**
   * Whether the pipeline can be paused.
   */
  readonly canPause: boolean;

  /**
   * Whether the pipeline can be resumed.
   */
  readonly canResume: boolean;

  /**
   * Whether the pipeline can be started.
   */
  readonly canStart: boolean;

  /**
   * Check if operation should proceed.
   * Combines signal check and pause wait for convenience.
   * @throws AbortError if canceled
   */
  checkAndWait: () => Promise<void>;

  /**
   * Mark the pipeline as complete. Transitions to complete state.
   * Should be called when all pipeline work finishes successfully.
   * @returns true if state changed, false if invalid transition
   */
  complete: () => boolean;

  /**
   * Mark the pipeline as errored. Transitions to error state.
   * @param error - Error message describing the failure
   * @returns true if state changed, false if invalid transition
   */
  fail: (error: string) => boolean;

  /**
   * Whether the pipeline is currently paused.
   */
  readonly isPaused: boolean;

  /**
   * Whether the pipeline is running (not idle, canceled, complete, or error).
   */
  readonly isRunning: boolean;

  /**
   * Pause the pipeline. Transitions from running to paused.
   * Blocks new work but doesn't abort in-flight operations.
   * @returns true if state changed, false if already paused or invalid transition
   */
  pause: () => boolean;

  /**
   * Reset the pipeline to idle state.
   * Can be called from any terminal state (canceled, complete, error).
   * Creates a fresh AbortController for the next run.
   * @returns true if state changed, false if not in terminal state
   */
  reset: () => boolean;

  /**
   * Resume a paused pipeline. Transitions from paused to running.
   * Unblocks waiters and allows new work to proceed.
   * @returns true if state changed, false if not paused
   */
  resume: () => boolean;

  /**
   * Get AbortSignal for cancellation.
   * Pass this to pipeline operations for graceful cancellation.
   */
  readonly signal: AbortSignal;

  /**
   * Start the pipeline. Transitions from idle to running.
   * @returns true if state changed, false if already running or invalid transition
   */
  start: () => boolean;
  /**
   * Get current pipeline state.
   */
  readonly state: PipelineState;

  /**
   * Wait if the pipeline is paused.
   * Call this before starting new work units to honor pause semantics.
   * Returns immediately if not paused.
   * Throws AbortError if canceled while waiting.
   */
  waitIfPaused: () => Promise<void>;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a pipeline controller instance.
 *
 * @param config - Controller configuration
 * @returns A configured pipeline controller
 */
export function createPipelineController(
  config: PipelineControllerConfig = {}
): PipelineController {
  const { onStateChange, initialState = 'idle' } = config;

  // Internal mutable state
  let state: PipelineState = initialState;
  let stateEnteredAt = Date.now();
  let abortController = new AbortController();
  const pauseWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  // -------------------------------------------------------------------------
  // State Helpers
  // -------------------------------------------------------------------------

  function transitionTo(newState: PipelineState, metadata?: Partial<StateChangeMetadata>): boolean {
    if (state === newState) {
      return false; // No change
    }

    const previousState = state;
    const now = Date.now();
    const durationInPreviousStateMs = now - stateEnteredAt;

    state = newState;
    stateEnteredAt = now;

    if (onStateChange) {
      onStateChange(newState, previousState, {
        durationInPreviousStateMs,
        timestamp: new Date().toISOString(),
        ...metadata,
      });
    }

    return true;
  }

  function isTerminalState(s: PipelineState): boolean {
    return s === 'canceled' || s === 'complete' || s === 'error';
  }

  function resolveAllWaiters(): void {
    while (pauseWaiters.length > 0) {
      const waiter = pauseWaiters.shift();
      waiter?.resolve();
    }
  }

  function rejectAllWaiters(error: Error): void {
    while (pauseWaiters.length > 0) {
      const waiter = pauseWaiters.shift();
      waiter?.reject(error);
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function start(): boolean {
    if (state !== 'idle') {
      return false;
    }
    return transitionTo('running');
  }

  function pause(): boolean {
    if (state !== 'running') {
      return false;
    }
    return transitionTo('paused');
  }

  function resume(): boolean {
    if (state !== 'paused') {
      return false;
    }
    const changed = transitionTo('running');
    if (changed) {
      resolveAllWaiters();
    }
    return changed;
  }

  function cancel(): boolean {
    if (isTerminalState(state) || state === 'idle') {
      return false;
    }
    // Abort any in-flight operations
    abortController.abort();
    // Reject all waiters with AbortError
    rejectAllWaiters(new DOMException('Pipeline canceled', 'AbortError'));
    return transitionTo('canceled');
  }

  function complete(): boolean {
    if (state !== 'running' && state !== 'paused') {
      return false;
    }
    resolveAllWaiters();
    return transitionTo('complete');
  }

  function fail(error: string): boolean {
    if (isTerminalState(state) || state === 'idle') {
      return false;
    }
    rejectAllWaiters(new Error(error));
    return transitionTo('error', { error });
  }

  function reset(): boolean {
    if (!isTerminalState(state)) {
      return false;
    }
    // Create fresh abort controller for next run
    abortController = new AbortController();
    return transitionTo('idle');
  }

  async function waitIfPaused(): Promise<void> {
    // Always check abort signal first (may be canceled while not paused)
    if (abortController.signal.aborted) {
      throw new DOMException('Pipeline canceled', 'AbortError');
    }

    if (state !== 'paused') {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      pauseWaiters.push({ reject, resolve });
    });
  }

  async function checkAndWait(): Promise<void> {
    // Check abort signal first
    if (abortController.signal.aborted) {
      throw new DOMException('Pipeline canceled', 'AbortError');
    }

    // Wait if paused
    await waitIfPaused();

    // Check again after resuming (may have been canceled while paused)
    if (abortController.signal.aborted) {
      throw new DOMException('Pipeline canceled', 'AbortError');
    }
  }

  // -------------------------------------------------------------------------
  // Return Controller Object
  // -------------------------------------------------------------------------

  return {
    get canCancel() {
      return state === 'running' || state === 'paused';
    },
    cancel,
    get canPause() {
      return state === 'running';
    },
    get canResume() {
      return state === 'paused';
    },
    get canStart() {
      return state === 'idle';
    },
    checkAndWait,
    complete,
    fail,
    get isPaused() {
      return state === 'paused';
    },
    get isRunning() {
      return state === 'running' || state === 'paused';
    },
    pause,
    reset,
    resume,
    get signal() {
      return abortController.signal;
    },
    start,
    get state() {
      return state;
    },
    waitIfPaused,
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Check if a state is a terminal state (pipeline has ended).
 *
 * @param state - Pipeline state to check
 * @returns true if state is terminal
 */
export function isTerminalState(state: PipelineState): boolean {
  return state === 'canceled' || state === 'complete' || state === 'error';
}

/**
 * Check if a state allows new work to proceed.
 *
 * @param state - Pipeline state to check
 * @returns true if state allows work
 */
export function isActiveState(state: PipelineState): boolean {
  return state === 'running';
}

/**
 * Get a human-readable description of a pipeline state.
 *
 * @param state - Pipeline state
 * @returns Human-readable description
 */
export function describeState(state: PipelineState): string {
  const descriptions: Record<PipelineState, string> = {
    canceled: 'Pipeline was canceled by user',
    complete: 'Pipeline completed successfully',
    error: 'Pipeline stopped due to an error',
    idle: 'Pipeline is idle and ready to start',
    paused: 'Pipeline is paused, waiting to resume',
    running: 'Pipeline is actively processing',
  };
  return descriptions[state];
}

/**
 * Get available actions for a given state.
 *
 * @param state - Current pipeline state
 * @returns Array of available action names
 */
export function getAvailableActions(
  state: PipelineState
): Array<'start' | 'pause' | 'resume' | 'cancel' | 'reset'> {
  switch (state) {
    case 'idle':
      return ['start'];
    case 'running':
      return ['pause', 'cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    case 'canceled':
    case 'complete':
    case 'error':
      return ['reset'];
    default:
      return [];
  }
}
