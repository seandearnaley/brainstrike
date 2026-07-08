import { describe, expect, it, vi } from 'vitest';
import {
  createEveryNthSampler,
  createLogSampler,
  createMilestoneSampler,
  createPercentSampler,
} from '../../src/log-sampling';

describe('log-sampling', () => {
  describe('createLogSampler', () => {
    it('logs everything when no options are provided', () => {
      const sampler = createLogSampler();

      for (let i = 0; i < 10; i++) {
        expect(sampler.shouldLog()).toBe(true);
      }

      const stats = sampler.getStats();
      expect(stats.totalCalls).toBe(10);
      expect(stats.loggedCalls).toBe(10);
      expect(stats.skippedCalls).toBe(0);
    });

    it('always logs the first N items when alwaysLogFirst is set', () => {
      const sampler = createLogSampler({ alwaysLogFirst: 3, everyNth: 100 });

      expect(sampler.shouldLog()).toBe(true); // 1st
      expect(sampler.shouldLog()).toBe(true); // 2nd
      expect(sampler.shouldLog()).toBe(true); // 3rd
      expect(sampler.shouldLog()).toBe(false); // 4th - not logged
    });

    it('respects everyNth option', () => {
      const sampler = createLogSampler({ alwaysLogFirst: 0, everyNth: 5 });
      const results: boolean[] = [];

      for (let i = 0; i < 15; i++) {
        results.push(sampler.shouldLog());
      }

      // Every 5th call (index 4, 9, 14) should be true
      expect(results.filter((r) => r).length).toBe(3);
      expect(results[4]).toBe(true);
      expect(results[9]).toBe(true);
      expect(results[14]).toBe(true);
    });

    it('forceLog bypasses sampling', () => {
      const sampler = createLogSampler({ alwaysLogFirst: 0, everyNth: 1000 });

      sampler.forceLog();
      sampler.forceLog();

      const stats = sampler.getStats();
      expect(stats.loggedCalls).toBe(2);
    });

    it('reset clears state', () => {
      const sampler = createLogSampler();

      sampler.shouldLog();
      sampler.shouldLog();
      sampler.shouldLog();

      expect(sampler.getStats().totalCalls).toBe(3);

      sampler.reset();

      expect(sampler.getStats().totalCalls).toBe(0);
      expect(sampler.getStats().loggedCalls).toBe(0);
    });

    it('logSummary calls the provided function with stats', () => {
      const sampler = createLogSampler({ alwaysLogFirst: 1, everyNth: 2 });
      sampler.shouldLog(); // 1st - logged (alwaysLogFirst)
      sampler.shouldLog(); // 2nd - logged (everyNth)
      sampler.shouldLog(); // 3rd - skipped
      sampler.shouldLog(); // 4th - logged (everyNth)

      const logFn = vi.fn();
      sampler.logSummary(logFn);

      expect(logFn).toHaveBeenCalledWith({
        loggedCalls: 3,
        sampleRate: 0.75,
        skippedCalls: 1,
        totalCalls: 4,
      });
    });
  });

  describe('createEveryNthSampler', () => {
    it('logs every nth item', () => {
      const sampler = createEveryNthSampler(3, 0);
      const results: boolean[] = [];

      for (let i = 0; i < 9; i++) {
        results.push(sampler.shouldLog());
      }

      // Indices 2, 5, 8 should be true
      expect(results).toEqual([false, false, true, false, false, true, false, false, true]);
    });

    it('respects alwaysLogFirst parameter', () => {
      const sampler = createEveryNthSampler(10, 2);

      expect(sampler.shouldLog()).toBe(true); // 1st - always
      expect(sampler.shouldLog()).toBe(true); // 2nd - always
      expect(sampler.shouldLog()).toBe(false); // 3rd - not 10th
    });
  });

  describe('createPercentSampler', () => {
    it('samples approximately the correct percentage', () => {
      // Use a high sample count for statistical accuracy
      const sampler = createPercentSampler(50, 0);
      let logged = 0;

      for (let i = 0; i < 1000; i++) {
        if (sampler.shouldLog()) {
          logged++;
        }
      }

      // Should be roughly 50% with some variance
      expect(logged).toBeGreaterThan(400);
      expect(logged).toBeLessThan(600);
    });

    it('clamps percentage to 0-100', () => {
      const sampler = createPercentSampler(150, 0); // Should clamp to 100%

      // With 100% sample rate, all should be logged
      for (let i = 0; i < 10; i++) {
        expect(sampler.shouldLog()).toBe(true);
      }
    });
  });

  describe('createMilestoneSampler', () => {
    it('logs at milestone points', () => {
      const sampler = createMilestoneSampler(100);
      const loggedIndices: number[] = [];

      for (let i = 0; i < 100; i++) {
        if (sampler.shouldLog()) {
          loggedIndices.push(i);
        }
      }

      // Should log at: 0%, 10%, 25%, 50%, 75%, 90%, last
      expect(loggedIndices).toContain(0); // 0%
      expect(loggedIndices).toContain(10); // 10%
      expect(loggedIndices).toContain(25); // 25%
      expect(loggedIndices).toContain(50); // 50%
      expect(loggedIndices).toContain(75); // 75%
      expect(loggedIndices).toContain(90); // 90%
      expect(loggedIndices).toContain(99); // last (100-1)
    });

    it('works with small total counts', () => {
      const sampler = createMilestoneSampler(5);
      const results: boolean[] = [];

      for (let i = 0; i < 5; i++) {
        results.push(sampler.shouldLog());
      }

      // With only 5 items, milestones overlap - first and last should be logged
      expect(results[0]).toBe(true);
      expect(results[4]).toBe(true);
    });

    it('reset allows reuse', () => {
      const sampler = createMilestoneSampler(10);

      for (let i = 0; i < 10; i++) {
        sampler.shouldLog();
      }

      const statsBefore = sampler.getStats();
      expect(statsBefore.totalCalls).toBe(10);

      sampler.reset();

      const statsAfter = sampler.getStats();
      expect(statsAfter.totalCalls).toBe(0);
    });
  });
});
