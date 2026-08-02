import { LogLevel } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBulkOperationContext,
  getBulkOperationLevel,
  isBulkOperationActive,
  registerBulkOperationPauseCallback,
  resetBulkOperationState,
  withBulkOperation,
  withBulkOperationSync,
} from '../../src/bulk-operation-context.js';

describe('bulk-operation-context', () => {
  afterEach(() => {
    resetBulkOperationState();
  });

  describe('createBulkOperationContext', () => {
    it('enters and exits bulk operation mode', () => {
      const context = createBulkOperationContext({ level: LogLevel.WARN });

      expect(isBulkOperationActive()).toBe(false);

      context.enter();
      expect(isBulkOperationActive()).toBe(true);
      expect(getBulkOperationLevel()).toBe(LogLevel.WARN);

      context.exit();
      expect(isBulkOperationActive()).toBe(false);
      expect(getBulkOperationLevel()).toBeNull();
    });

    it('supports nested enter/exit (reference counting)', () => {
      const context = createBulkOperationContext({ level: LogLevel.ERROR });

      context.enter();
      expect(isBulkOperationActive()).toBe(true);

      context.enter(); // Second enter
      expect(isBulkOperationActive()).toBe(true);

      context.exit(); // First exit - should still be active
      expect(isBulkOperationActive()).toBe(true);

      context.exit(); // Second exit - now should be inactive
      expect(isBulkOperationActive()).toBe(false);
    });

    it('calls onEnter and onExit callbacks', () => {
      const onEnter = vi.fn();
      const onExit = vi.fn();

      const context = createBulkOperationContext({
        level: LogLevel.WARN,
        onEnter,
        onExit,
      });

      context.enter();
      expect(onEnter).toHaveBeenCalledTimes(1);
      expect(onExit).not.toHaveBeenCalled();

      context.exit();
      expect(onEnter).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('isActive returns correct state', () => {
      const context = createBulkOperationContext();

      expect(context.isActive()).toBe(false);
      context.enter();
      expect(context.isActive()).toBe(true);
      context.exit();
      expect(context.isActive()).toBe(false);
    });
  });

  describe('registerBulkOperationPauseCallback', () => {
    it('calls pause callbacks on enter and resume callbacks on exit', () => {
      const onPause = vi.fn();
      const onResume = vi.fn();

      const unregister = registerBulkOperationPauseCallback(onPause, onResume);

      const context = createBulkOperationContext();
      context.enter();
      expect(onPause).toHaveBeenCalledTimes(1);
      expect(onResume).not.toHaveBeenCalled();

      context.exit();
      expect(onPause).toHaveBeenCalledTimes(1);
      expect(onResume).toHaveBeenCalledTimes(1);

      unregister();
    });

    it('unregister removes callbacks', () => {
      const onPause = vi.fn();
      const onResume = vi.fn();

      const unregister = registerBulkOperationPauseCallback(onPause, onResume);
      unregister();

      const context = createBulkOperationContext();
      context.enter();
      context.exit();

      expect(onPause).not.toHaveBeenCalled();
      expect(onResume).not.toHaveBeenCalled();
    });
  });

  describe('withBulkOperation', () => {
    it('wraps async function with bulk operation context', async () => {
      let wasActive = false;

      await withBulkOperation(async () => {
        wasActive = isBulkOperationActive();
        return 'result';
      });

      expect(wasActive).toBe(true);
      expect(isBulkOperationActive()).toBe(false);
    });

    it('exits context even on error', async () => {
      try {
        await withBulkOperation(async () => {
          expect(isBulkOperationActive()).toBe(true);
          throw new Error('test error');
        });
      } catch {
        // Expected
      }

      expect(isBulkOperationActive()).toBe(false);
    });

    it('returns the function result', async () => {
      const result = await withBulkOperation(async () => ({ value: 42 }));

      expect(result).toEqual({ value: 42 });
    });
  });

  describe('withBulkOperationSync', () => {
    it('wraps sync function with bulk operation context', () => {
      let wasActive = false;

      withBulkOperationSync(() => {
        wasActive = isBulkOperationActive();
        return 'result';
      });

      expect(wasActive).toBe(true);
      expect(isBulkOperationActive()).toBe(false);
    });

    it('exits context even on error', () => {
      try {
        withBulkOperationSync(() => {
          expect(isBulkOperationActive()).toBe(true);
          throw new Error('test error');
        });
      } catch {
        // Expected
      }

      expect(isBulkOperationActive()).toBe(false);
    });
  });

  describe('default options', () => {
    it('uses WARN level by default', () => {
      const context = createBulkOperationContext();
      context.enter();

      expect(getBulkOperationLevel()).toBe(LogLevel.WARN);

      context.exit();
    });
  });
});
