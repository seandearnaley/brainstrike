/**
 * Tests for QueueAdapter control semantics (BST-164).
 *
 * Validates the standardized pause/resume/cancel/drain semantics
 * defined in ADR-0002 using a mock adapter implementation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueAdapter, QueueResult, TaskPayload } from '../types';

/**
 * Creates a mock QueueAdapter for testing control semantics.
 *
 * This mirrors the browser-workerpool implementation logic but
 * uses simple promises instead of actual web workers.
 */
function createMockAdapter(): QueueAdapter & { simulateTaskComplete: (id: string) => void } {
  let paused = false;
  let canceled = false;
  let activeTasks = 0;
  const resumeWaiters: Array<() => void> = [];
  const drainWaiters: Array<() => void> = [];
  const cancelWaiters: Array<() => void> = [];
  const pendingTasks: Map<
    string,
    { resolve: (r: QueueResult) => void; reject: (e: Error) => void }
  > = new Map();

  const notifyDrain = () => {
    if (activeTasks === 0) {
      while (drainWaiters.length > 0) {
        const resolve = drainWaiters.pop();
        resolve?.();
      }
    }
  };

  const notifyCancel = () => {
    if (activeTasks === 0) {
      while (cancelWaiters.length > 0) {
        const resolve = cancelWaiters.pop();
        resolve?.();
      }
    }
  };

  return {
    add(task: TaskPayload) {
      if (canceled) {
        return Promise.reject(new Error('Adapter has been canceled'));
      }
      if (paused) {
        // Queue the task to run after resume
        return new Promise<QueueResult>((outerResolve, outerReject) => {
          resumeWaiters.push(() => {
            activeTasks += 1;
            new Promise<QueueResult>((resolve, reject) => {
              pendingTasks.set(task.id, { reject, resolve });
            })
              .then(outerResolve)
              .catch(outerReject)
              .finally(() => {
                activeTasks = Math.max(activeTasks - 1, 0);
                pendingTasks.delete(task.id);
                notifyDrain();
                notifyCancel();
              });
          });
        });
      }

      // Not paused - start immediately
      activeTasks += 1;
      return new Promise<QueueResult>((resolve, reject) => {
        pendingTasks.set(task.id, { reject, resolve });
      }).finally(() => {
        activeTasks = Math.max(activeTasks - 1, 0);
        pendingTasks.delete(task.id);
        notifyDrain();
        notifyCancel();
      });
    },

    async addBulk(tasks: readonly TaskPayload[]) {
      if (canceled) {
        throw new Error('Adapter has been canceled');
      }
      const promises = tasks.map((task) => this.add(task));
      return Promise.all(promises);
    },

    async cancel() {
      if (canceled) {
        return;
      }
      canceled = true;
      paused = true;

      // Reject all pending tasks
      for (const [id, { reject }] of pendingTasks) {
        reject(new Error(`Task ${id} canceled`));
      }
      pendingTasks.clear();

      if (activeTasks > 0) {
        await new Promise<void>((resolve) => {
          cancelWaiters.push(resolve);
        });
      }
    },

    async drain() {
      if (activeTasks === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },

    get isPaused() {
      return paused;
    },

    get isProcessing() {
      return activeTasks > 0;
    },

    onProgress(_listener) {
      return () => {};
    },

    pause() {
      paused = true;
    },

    resume() {
      if (!paused) {
        return;
      }
      paused = false;
      while (resumeWaiters.length > 0) {
        const resolve = resumeWaiters.shift();
        resolve?.();
      }
    },

    // Test helper to simulate task completion
    simulateTaskComplete(id: string) {
      const task = pendingTasks.get(id);
      if (task) {
        task.resolve({
          id,
          metadata: {
            batchSize: 1,
            device: 'wasm',
            dimensions: 3,
            dtype: 'fp32',
            elapsedMs: 10,
            fallbackApplied: false,
            model: 'test-model',
          },
          type: 'result',
          vectors: [new Float32Array([0.1, 0.2, 0.3])],
        });
      }
    },
  };
}

const createTask = (id: string): TaskPayload => ({
  deviceHint: 'wasm',
  id,
  kind: 'embed',
  model: 'test-model',
  texts: ['test'],
});

describe('QueueAdapter control semantics (BST-164)', () => {
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    adapter = createMockAdapter();
  });

  describe('isPaused getter', () => {
    it('returns false initially', () => {
      expect(adapter.isPaused).toBe(false);
    });

    it('returns true after pause()', () => {
      adapter.pause();
      expect(adapter.isPaused).toBe(true);
    });

    it('returns false after pause() then resume()', () => {
      adapter.pause();
      adapter.resume();
      expect(adapter.isPaused).toBe(false);
    });

    it('resume() is idempotent when not paused', () => {
      adapter.resume();
      expect(adapter.isPaused).toBe(false);
    });
  });

  describe('isProcessing getter', () => {
    it('returns false initially', () => {
      expect(adapter.isProcessing).toBe(false);
    });

    it('returns true while task is pending', async () => {
      const task = createTask('task-1');
      const promise = adapter.add(task);

      // Task is now pending
      expect(adapter.isProcessing).toBe(true);

      // Complete the task
      adapter.simulateTaskComplete('task-1');
      await promise;

      expect(adapter.isProcessing).toBe(false);
    });

    it('tracks multiple concurrent tasks', async () => {
      const task1 = createTask('task-1');
      const task2 = createTask('task-2');

      const promise1 = adapter.add(task1);
      const promise2 = adapter.add(task2);

      expect(adapter.isProcessing).toBe(true);

      adapter.simulateTaskComplete('task-1');
      await promise1;

      // Still processing task-2
      expect(adapter.isProcessing).toBe(true);

      adapter.simulateTaskComplete('task-2');
      await promise2;

      expect(adapter.isProcessing).toBe(false);
    });
  });

  describe('pause() and resume()', () => {
    it('pause() blocks new tasks from starting', async () => {
      adapter.pause();

      const task = createTask('task-1');
      let taskStarted = false;

      const addPromise = adapter.add(task).then((result) => {
        taskStarted = true;
        return result;
      });

      // Give time for task to potentially start
      await vi.waitFor(
        () => {
          // Task should still be blocked
          expect(taskStarted).toBe(false);
        },
        { timeout: 100 }
      );

      // Resume and complete
      adapter.resume();
      // Wait a tick for resume to process
      await new Promise((r) => setTimeout(r, 0));

      adapter.simulateTaskComplete('task-1');
      await addPromise;
      expect(taskStarted).toBe(true);
    });

    it('resume() releases paused tasks', async () => {
      adapter.pause();

      const resolvedOrder: string[] = [];

      const promise1 = adapter.add(createTask('task-1')).then(() => {
        resolvedOrder.push('task-1');
      });
      const promise2 = adapter.add(createTask('task-2')).then(() => {
        resolvedOrder.push('task-2');
      });

      // Resume and complete tasks
      adapter.resume();
      await new Promise((r) => setTimeout(r, 0));

      adapter.simulateTaskComplete('task-1');
      adapter.simulateTaskComplete('task-2');
      await Promise.all([promise1, promise2]);

      expect(resolvedOrder).toHaveLength(2);
    });
  });

  describe('cancel()', () => {
    it('prevents new task submission', async () => {
      await adapter.cancel();

      const task = createTask('task-1');
      await expect(adapter.add(task)).rejects.toThrow('Adapter has been canceled');
    });

    it('prevents bulk task submission', async () => {
      await adapter.cancel();

      const tasks = [createTask('task-1'), createTask('task-2')];
      await expect(adapter.addBulk(tasks)).rejects.toThrow('Adapter has been canceled');
    });

    it('sets isPaused to true', async () => {
      expect(adapter.isPaused).toBe(false);
      await adapter.cancel();
      expect(adapter.isPaused).toBe(true);
    });

    it('is idempotent (calling twice does not error)', async () => {
      await adapter.cancel();
      await adapter.cancel(); // Should not throw
      expect(adapter.isPaused).toBe(true);
    });
  });

  describe('drain()', () => {
    it('resolves immediately when no tasks are pending', async () => {
      expect(adapter.isProcessing).toBe(false);
      await adapter.drain(); // Should resolve immediately
    });

    it('waits for pending tasks to complete', async () => {
      const task = createTask('task-1');
      const taskPromise = adapter.add(task);

      let drained = false;
      const drainPromise = adapter.drain().then(() => {
        drained = true;
      });

      // Drain should be waiting
      await new Promise((r) => setTimeout(r, 10));
      expect(drained).toBe(false);

      // Complete the task
      adapter.simulateTaskComplete('task-1');
      await taskPromise;
      await drainPromise;

      expect(drained).toBe(true);
    });
  });

  describe('interface contract', () => {
    it('QueueAdapter has all required control methods', () => {
      // TypeScript compile-time check - these would fail to compile if missing
      const methods: Array<keyof QueueAdapter> = [
        'add',
        'addBulk',
        'onProgress',
        'pause',
        'resume',
        'cancel',
        'drain',
        'isPaused',
        'isProcessing',
      ];

      for (const method of methods) {
        expect(method in adapter).toBe(true);
      }
    });

    it('isPaused is a readonly getter (not a method)', () => {
      // Verify it's accessed as a property, not a method call
      expect(typeof adapter.isPaused).toBe('boolean');
    });

    it('isProcessing is a readonly getter (not a method)', () => {
      expect(typeof adapter.isProcessing).toBe('boolean');
    });
  });
});
