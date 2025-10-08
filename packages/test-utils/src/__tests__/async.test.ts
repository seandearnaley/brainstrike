import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAllTimersAndMicrotasks, flushMicrotasks } from '../async';

describe('async utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('flushMicrotasks', () => {
    it('should flush pending microtasks once by default', async () => {
      let completed = false;
      Promise.resolve().then(() => {
        completed = true;
      });

      expect(completed).toBe(false);

      await flushMicrotasks();

      expect(completed).toBe(true);
    });

    it('should flush microtasks multiple times when specified', async () => {
      let count = 0;

      Promise.resolve().then(() => {
        count += 1;
        Promise.resolve().then(() => {
          count += 1;
          Promise.resolve().then(() => {
            count += 1;
          });
        });
      });

      await flushMicrotasks(3);

      expect(count).toBe(3);
    });

    it('should handle nested microtasks', async () => {
      const results: string[] = [];

      Promise.resolve().then(() => {
        results.push('first');
        Promise.resolve().then(() => {
          results.push('second');
        });
      });

      await flushMicrotasks(2);

      expect(results).toEqual(['first', 'second']);
    });

    it('should work with zero flushes', async () => {
      let completed = false;
      Promise.resolve().then(() => {
        completed = true;
      });

      await flushMicrotasks(0);

      // Even with 0 iterations, the await itself processes microtasks
      // so the promise still resolves
      expect(completed).toBe(true);
    });
  });

  describe('flushAllTimersAndMicrotasks', () => {
    it('should run all timers and flush microtasks', async () => {
      let timerRan = false;
      let microtaskRan = false;

      setTimeout(() => {
        timerRan = true;
      }, 1000);

      Promise.resolve().then(() => {
        microtaskRan = true;
      });

      await flushAllTimersAndMicrotasks();

      expect(timerRan).toBe(true);
      expect(microtaskRan).toBe(true);
    });

    it('should flush microtasks multiple times based on parameter', async () => {
      let count = 0;

      setTimeout(() => {
        Promise.resolve().then(() => {
          count += 1;
          Promise.resolve().then(() => {
            count += 1;
          });
        });
      }, 100);

      await flushAllTimersAndMicrotasks(2);

      expect(count).toBe(2);
    });

    it('should handle timers that schedule more timers', async () => {
      const events: string[] = [];

      setTimeout(() => {
        events.push('timer1');
        setTimeout(() => {
          events.push('timer2');
        }, 100);
      }, 100);

      await flushAllTimersAndMicrotasks();

      expect(events).toEqual(['timer1', 'timer2']);
    });

    it('should work with custom microtask count', async () => {
      let count = 0;

      setTimeout(() => {
        Promise.resolve().then(() => {
          count += 1;
          Promise.resolve().then(() => {
            count += 1;
            Promise.resolve().then(() => {
              count += 1;
            });
          });
        });
      }, 100);

      await flushAllTimersAndMicrotasks(3);

      expect(count).toBe(3);
    });
  });
});
