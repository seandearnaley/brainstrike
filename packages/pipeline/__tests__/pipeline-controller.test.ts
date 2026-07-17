/**
 * Tests for the pipeline controller module.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPipelineController,
  describeState,
  getAvailableActions,
  isActiveState,
  isTerminalState,
  type PipelineController,
  type PipelineState,
} from '../src/pipeline-controller.js';

describe('createPipelineController', () => {
  let controller: PipelineController;

  beforeEach(() => {
    controller = createPipelineController();
  });

  describe('initial state', () => {
    it('starts in idle state', () => {
      expect(controller.state).toBe('idle');
    });

    it('has valid abort signal', () => {
      expect(controller.signal).toBeInstanceOf(AbortSignal);
      expect(controller.signal.aborted).toBe(false);
    });

    it('is not paused initially', () => {
      expect(controller.isPaused).toBe(false);
    });

    it('is not running initially', () => {
      expect(controller.isRunning).toBe(false);
    });

    it('can start from idle', () => {
      expect(controller.canStart).toBe(true);
    });

    it('cannot pause from idle', () => {
      expect(controller.canPause).toBe(false);
    });

    it('cannot resume from idle', () => {
      expect(controller.canResume).toBe(false);
    });

    it('cannot cancel from idle', () => {
      expect(controller.canCancel).toBe(false);
    });
  });

  describe('custom initial state', () => {
    it('accepts custom initial state', () => {
      const c = createPipelineController({ initialState: 'running' });
      expect(c.state).toBe('running');
      expect(c.isRunning).toBe(true);
    });
  });

  describe('start()', () => {
    it('transitions from idle to running', () => {
      const result = controller.start();
      expect(result).toBe(true);
      expect(controller.state).toBe('running');
    });

    it('returns false when already running', () => {
      controller.start();
      const result = controller.start();
      expect(result).toBe(false);
      expect(controller.state).toBe('running');
    });

    it('returns false from paused state', () => {
      controller.start();
      controller.pause();
      const result = controller.start();
      expect(result).toBe(false);
      expect(controller.state).toBe('paused');
    });

    it('returns false from terminal states', () => {
      controller.start();
      controller.complete();
      const result = controller.start();
      expect(result).toBe(false);
      expect(controller.state).toBe('complete');
    });
  });

  describe('pause()', () => {
    it('transitions from running to paused', () => {
      controller.start();
      const result = controller.pause();
      expect(result).toBe(true);
      expect(controller.state).toBe('paused');
      expect(controller.isPaused).toBe(true);
    });

    it('returns false when not running', () => {
      const result = controller.pause();
      expect(result).toBe(false);
      expect(controller.state).toBe('idle');
    });

    it('returns false when already paused', () => {
      controller.start();
      controller.pause();
      const result = controller.pause();
      expect(result).toBe(false);
      expect(controller.state).toBe('paused');
    });

    it('keeps isRunning true when paused', () => {
      controller.start();
      controller.pause();
      expect(controller.isRunning).toBe(true); // Still considered running
    });
  });

  describe('resume()', () => {
    it('transitions from paused to running', () => {
      controller.start();
      controller.pause();
      const result = controller.resume();
      expect(result).toBe(true);
      expect(controller.state).toBe('running');
      expect(controller.isPaused).toBe(false);
    });

    it('returns false when not paused', () => {
      controller.start();
      const result = controller.resume();
      expect(result).toBe(false);
      expect(controller.state).toBe('running');
    });

    it('returns false from idle', () => {
      const result = controller.resume();
      expect(result).toBe(false);
    });
  });

  describe('cancel()', () => {
    it('transitions from running to canceled', () => {
      controller.start();
      const result = controller.cancel();
      expect(result).toBe(true);
      expect(controller.state).toBe('canceled');
    });

    it('transitions from paused to canceled', () => {
      controller.start();
      controller.pause();
      const result = controller.cancel();
      expect(result).toBe(true);
      expect(controller.state).toBe('canceled');
    });

    it('aborts the signal', () => {
      controller.start();
      controller.cancel();
      expect(controller.signal.aborted).toBe(true);
    });

    it('returns false from idle', () => {
      const result = controller.cancel();
      expect(result).toBe(false);
    });

    it('returns false when already canceled', () => {
      controller.start();
      controller.cancel();
      const result = controller.cancel();
      expect(result).toBe(false);
    });

    it('returns false from complete state', () => {
      controller.start();
      controller.complete();
      const result = controller.cancel();
      expect(result).toBe(false);
    });
  });

  describe('complete()', () => {
    it('transitions from running to complete', () => {
      controller.start();
      const result = controller.complete();
      expect(result).toBe(true);
      expect(controller.state).toBe('complete');
    });

    it('transitions from paused to complete', () => {
      controller.start();
      controller.pause();
      const result = controller.complete();
      expect(result).toBe(true);
      expect(controller.state).toBe('complete');
    });

    it('returns false from idle', () => {
      const result = controller.complete();
      expect(result).toBe(false);
    });

    it('returns false when already complete', () => {
      controller.start();
      controller.complete();
      const result = controller.complete();
      expect(result).toBe(false);
    });
  });

  describe('fail()', () => {
    it('transitions from running to error', () => {
      controller.start();
      const result = controller.fail('Something went wrong');
      expect(result).toBe(true);
      expect(controller.state).toBe('error');
    });

    it('transitions from paused to error', () => {
      controller.start();
      controller.pause();
      const result = controller.fail('Error during pause');
      expect(result).toBe(true);
      expect(controller.state).toBe('error');
    });

    it('returns false from idle', () => {
      const result = controller.fail('Cannot fail from idle');
      expect(result).toBe(false);
    });

    it('returns false from terminal states', () => {
      controller.start();
      controller.cancel();
      const result = controller.fail('Cannot fail when canceled');
      expect(result).toBe(false);
    });
  });

  describe('reset()', () => {
    it('transitions from canceled to idle', () => {
      controller.start();
      controller.cancel();
      const result = controller.reset();
      expect(result).toBe(true);
      expect(controller.state).toBe('idle');
    });

    it('transitions from complete to idle', () => {
      controller.start();
      controller.complete();
      const result = controller.reset();
      expect(result).toBe(true);
      expect(controller.state).toBe('idle');
    });

    it('transitions from error to idle', () => {
      controller.start();
      controller.fail('Error');
      const result = controller.reset();
      expect(result).toBe(true);
      expect(controller.state).toBe('idle');
    });

    it('creates fresh abort controller', () => {
      controller.start();
      controller.cancel();
      const oldSignal = controller.signal;
      controller.reset();
      expect(controller.signal).not.toBe(oldSignal);
      expect(controller.signal.aborted).toBe(false);
    });

    it('returns false from running', () => {
      controller.start();
      const result = controller.reset();
      expect(result).toBe(false);
    });

    it('returns false from paused', () => {
      controller.start();
      controller.pause();
      const result = controller.reset();
      expect(result).toBe(false);
    });

    it('returns false from idle', () => {
      const result = controller.reset();
      expect(result).toBe(false);
    });
  });

  describe('waitIfPaused()', () => {
    it('resolves immediately when not paused', async () => {
      controller.start();
      await expect(controller.waitIfPaused()).resolves.toBeUndefined();
    });

    it('resolves immediately when idle', async () => {
      await expect(controller.waitIfPaused()).resolves.toBeUndefined();
    });

    it('blocks when paused and resolves on resume', async () => {
      controller.start();
      controller.pause();

      let resolved = false;
      const waitPromise = controller.waitIfPaused().then(() => {
        resolved = true;
      });

      // Should still be waiting
      await Promise.resolve(); // microtask
      expect(resolved).toBe(false);

      // Resume should resolve the waiter
      controller.resume();
      await waitPromise;
      expect(resolved).toBe(true);
    });

    it('rejects with AbortError when canceled while waiting', async () => {
      controller.start();
      controller.pause();

      const waitPromise = controller.waitIfPaused();

      controller.cancel();

      await expect(waitPromise).rejects.toThrow('Pipeline canceled');
    });

    it('throws immediately if already aborted', async () => {
      controller.start();
      controller.cancel();

      await expect(controller.waitIfPaused()).rejects.toThrow('Pipeline canceled');
    });
  });

  describe('checkAndWait()', () => {
    it('resolves when running', async () => {
      controller.start();
      await expect(controller.checkAndWait()).resolves.toBeUndefined();
    });

    it('throws when aborted', async () => {
      controller.start();
      controller.cancel();
      await expect(controller.checkAndWait()).rejects.toThrow('Pipeline canceled');
    });

    it('waits when paused then resolves on resume', async () => {
      controller.start();
      controller.pause();

      let resolved = false;
      const checkPromise = controller.checkAndWait().then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      controller.resume();
      await checkPromise;
      expect(resolved).toBe(true);
    });

    it('throws if canceled while paused', async () => {
      controller.start();
      controller.pause();

      const checkPromise = controller.checkAndWait();
      controller.cancel();

      await expect(checkPromise).rejects.toThrow('Pipeline canceled');
    });
  });

  describe('multiple waiters', () => {
    it('resolves all waiters on resume', async () => {
      controller.start();
      controller.pause();

      const promises = [
        controller.waitIfPaused(),
        controller.waitIfPaused(),
        controller.waitIfPaused(),
      ];

      controller.resume();

      await expect(Promise.all(promises)).resolves.toBeDefined();
    });

    it('rejects all waiters on cancel', async () => {
      controller.start();
      controller.pause();

      const promises = [
        controller.waitIfPaused().catch((e) => e),
        controller.waitIfPaused().catch((e) => e),
        controller.waitIfPaused().catch((e) => e),
      ];

      controller.cancel();

      const errors = await Promise.all(promises);
      expect(errors).toHaveLength(3);
      for (const error of errors) {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe('AbortError');
      }
    });

    it('resolves all waiters on complete', async () => {
      controller.start();
      controller.pause();

      const promises = [controller.waitIfPaused(), controller.waitIfPaused()];

      controller.complete();

      await expect(Promise.all(promises)).resolves.toBeDefined();
    });
  });
});

describe('onStateChange callback', () => {
  it('calls callback on state transitions', () => {
    const onStateChange = vi.fn();
    const controller = createPipelineController({ onStateChange });

    controller.start();

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith(
      'running',
      'idle',
      expect.objectContaining({
        durationInPreviousStateMs: expect.any(Number),
        timestamp: expect.any(String),
      })
    );
  });

  it('includes error in metadata for fail transition', () => {
    const onStateChange = vi.fn();
    const controller = createPipelineController({ onStateChange });

    controller.start();
    controller.fail('Test error');

    expect(onStateChange).toHaveBeenCalledTimes(2);
    expect(onStateChange).toHaveBeenLastCalledWith(
      'error',
      'running',
      expect.objectContaining({
        error: 'Test error',
      })
    );
  });

  it('does not call callback when transition fails', () => {
    const onStateChange = vi.fn();
    const controller = createPipelineController({ onStateChange });

    // Try to pause from idle (invalid)
    controller.pause();

    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('tracks duration between state transitions', async () => {
    vi.useFakeTimers();
    const onStateChange = vi.fn();
    const controller = createPipelineController({ onStateChange });

    controller.start();
    vi.advanceTimersByTime(1000);
    controller.pause();

    expect(onStateChange).toHaveBeenLastCalledWith(
      'paused',
      'running',
      expect.objectContaining({
        durationInPreviousStateMs: 1000,
      })
    );

    vi.useRealTimers();
  });
});

describe('utility functions', () => {
  describe('isTerminalState', () => {
    it('returns true for terminal states', () => {
      expect(isTerminalState('canceled')).toBe(true);
      expect(isTerminalState('complete')).toBe(true);
      expect(isTerminalState('error')).toBe(true);
    });

    it('returns false for non-terminal states', () => {
      expect(isTerminalState('idle')).toBe(false);
      expect(isTerminalState('running')).toBe(false);
      expect(isTerminalState('paused')).toBe(false);
    });
  });

  describe('isActiveState', () => {
    it('returns true only for running', () => {
      expect(isActiveState('running')).toBe(true);
    });

    it('returns false for other states', () => {
      expect(isActiveState('idle')).toBe(false);
      expect(isActiveState('paused')).toBe(false);
      expect(isActiveState('canceled')).toBe(false);
      expect(isActiveState('complete')).toBe(false);
      expect(isActiveState('error')).toBe(false);
    });
  });

  describe('describeState', () => {
    it('returns description for each state', () => {
      const states: PipelineState[] = [
        'idle',
        'running',
        'paused',
        'canceled',
        'complete',
        'error',
      ];
      for (const state of states) {
        const description = describeState(state);
        expect(typeof description).toBe('string');
        expect(description.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getAvailableActions', () => {
    it('returns start for idle', () => {
      expect(getAvailableActions('idle')).toEqual(['start']);
    });

    it('returns pause and cancel for running', () => {
      expect(getAvailableActions('running')).toEqual(['pause', 'cancel']);
    });

    it('returns resume and cancel for paused', () => {
      expect(getAvailableActions('paused')).toEqual(['resume', 'cancel']);
    });

    it('returns reset for terminal states', () => {
      expect(getAvailableActions('canceled')).toEqual(['reset']);
      expect(getAvailableActions('complete')).toEqual(['reset']);
      expect(getAvailableActions('error')).toEqual(['reset']);
    });
  });
});

describe('integration scenarios', () => {
  it('full lifecycle: idle → running → paused → running → complete → idle', () => {
    const controller = createPipelineController();

    expect(controller.state).toBe('idle');

    controller.start();
    expect(controller.state).toBe('running');

    controller.pause();
    expect(controller.state).toBe('paused');

    controller.resume();
    expect(controller.state).toBe('running');

    controller.complete();
    expect(controller.state).toBe('complete');

    controller.reset();
    expect(controller.state).toBe('idle');
  });

  it('cancel during pause: idle → running → paused → canceled → idle', () => {
    const controller = createPipelineController();

    controller.start();
    controller.pause();
    controller.cancel();

    expect(controller.state).toBe('canceled');
    expect(controller.signal.aborted).toBe(true);

    controller.reset();
    expect(controller.state).toBe('idle');
    expect(controller.signal.aborted).toBe(false);
  });

  it('error recovery: idle → running → error → idle → running', () => {
    const controller = createPipelineController();

    controller.start();
    controller.fail('Network error');
    expect(controller.state).toBe('error');

    controller.reset();
    expect(controller.state).toBe('idle');

    controller.start();
    expect(controller.state).toBe('running');
  });

  it('abort signal integrates with fetch-like operations', async () => {
    const controller = createPipelineController();
    controller.start();

    // Simulate a fetch-like operation that respects AbortSignal
    const mockFetch = async (signal: AbortSignal): Promise<string> => {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return 'data';
    };

    // Should work normally
    await expect(mockFetch(controller.signal)).resolves.toBe('data');

    // Cancel the pipeline
    controller.cancel();

    // Should throw AbortError
    await expect(mockFetch(controller.signal)).rejects.toThrow('Aborted');
  });
});
