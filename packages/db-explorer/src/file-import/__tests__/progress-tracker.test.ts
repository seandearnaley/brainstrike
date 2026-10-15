// @vitest-environment node
import type { ImportProgress } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { ImportProgressTracker } from '../progress-tracker';

describe('ImportProgressTracker', () => {
  describe('constructor and initial state', () => {
    it('initializes with correct total and zero completed', () => {
      const tracker = new ImportProgressTracker(10);

      const progress = tracker.snapshot();
      expect(progress.total).toBe(10);
      expect(progress.completed).toBe(0);
      expect(progress.errors).toEqual([]);
    });

    it('initializes without listener', () => {
      const tracker = new ImportProgressTracker(5);

      // Should not throw when emitting without listener
      expect(() => tracker.emitInitial()).not.toThrow();
    });

    it('initializes with listener', () => {
      const listener = vi.fn();
      const tracker = new ImportProgressTracker(10, listener);

      tracker.emitInitial();

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({
        completed: 0,
        errors: [],
        total: 10,
      });
    });
  });

  describe('emitInitial', () => {
    it('calls listener with initial progress', () => {
      const listener = vi.fn();
      const tracker = new ImportProgressTracker(5, listener);

      tracker.emitInitial();

      expect(listener).toHaveBeenCalledWith({
        completed: 0,
        errors: [],
        total: 5,
      });
    });

    it('does not throw when no listener provided', () => {
      const tracker = new ImportProgressTracker(5);

      expect(() => tracker.emitInitial()).not.toThrow();
    });
  });

  describe('addError', () => {
    it('adds single error and notifies listener', () => {
      const listener = vi.fn();
      const tracker = new ImportProgressTracker(10, listener);

      tracker.addError({ error: 'File not found', file: 'test.txt' });

      expect(listener).toHaveBeenCalledWith({
        completed: 0,
        errors: [{ error: 'File not found', file: 'test.txt' }],
        total: 10,
      });
    });

    it('accumulates multiple errors', () => {
      const listener = vi.fn();
      const tracker = new ImportProgressTracker(10, listener);

      tracker.addError({ error: 'Error 1', file: 'file1.txt' });
      tracker.addError({ error: 'Error 2', file: 'file2.txt' });

      const progress = tracker.snapshot();
      expect(progress.errors).toHaveLength(2);
      expect(progress.errors).toEqual([
        { error: 'Error 1', file: 'file1.txt' },
        { error: 'Error 2', file: 'file2.txt' },
      ]);
    });

    it('increments errorCount property', () => {
      const tracker = new ImportProgressTracker(10);

      expect(tracker.errorCount).toBe(0);

      tracker.addError({ error: 'Error', file: 'test.txt' });
      expect(tracker.errorCount).toBe(1);

      tracker.addError({ error: 'Error 2', file: 'test2.txt' });
      expect(tracker.errorCount).toBe(2);
    });
  });

  describe('addErrors', () => {
    it('adds multiple errors at once', () => {
      const listener = vi.fn();
      const tracker = new ImportProgressTracker(10, listener);

      tracker.addErrors([
        { error: 'Error 1', file: 'file1.txt' },
        { error: 'Error 2', file: 'file2.txt' },
        { error: 'Error 3', file: 'file3.txt' },
      ]);

      expect(listener).toHaveBeenCalledWith({
        completed: 0,
        errors: [
          { error: 'Error 1', file: 'file1.txt' },
          { error: 'Error 2', file: 'file2.txt' },
          { error: 'Error 3', file: 'file3.txt' },
        ],
        total: 10,
      });
    });

    it('does not notify listener when adding empty errors array', () => {
      const listener = vi.fn();
      const tracker = new ImportProgressTracker(10, listener);

      tracker.addErrors([]);

      expect(listener).not.toHaveBeenCalled();
    });

    it('accumulates with existing errors', () => {
      const tracker = new ImportProgressTracker(10);

      tracker.addError({ error: 'Existing error', file: 'existing.txt' });
      tracker.addErrors([
        { error: 'New error 1', file: 'new1.txt' },
        { error: 'New error 2', file: 'new2.txt' },
      ]);

      const progress = tracker.snapshot();
      expect(progress.errors).toHaveLength(3);
    });
  });

  describe('update', () => {
    it('updates completed count and notifies listener', () => {
      const listener = vi.fn();
      const tracker = new ImportProgressTracker(10, listener);

      tracker.update(5);

      expect(listener).toHaveBeenCalledWith({
        completed: 5,
        errors: [],
        total: 10,
      });
    });

    it('updates with current file name', () => {
      const listener = vi.fn();
      const tracker = new ImportProgressTracker(10, listener);

      tracker.update(3, 'processing-file.txt');

      expect(listener).toHaveBeenCalledWith({
        completed: 3,
        current: 'processing-file.txt',
        errors: [],
        total: 10,
      });
    });

    it('caps completed at total', () => {
      const tracker = new ImportProgressTracker(10);

      tracker.update(15);

      const progress = tracker.snapshot();
      expect(progress.completed).toBe(10);
    });

    it('allows completed less than total', () => {
      const tracker = new ImportProgressTracker(10);

      tracker.update(3);

      const progress = tracker.snapshot();
      expect(progress.completed).toBe(3);
    });

    it('updates current file name on subsequent calls', () => {
      const tracker = new ImportProgressTracker(10);

      tracker.update(1, 'file1.txt');
      expect(tracker.snapshot().current).toBe('file1.txt');

      tracker.update(2, 'file2.txt');
      expect(tracker.snapshot().current).toBe('file2.txt');
    });
  });

  describe('clearCurrent', () => {
    it('removes current file from progress', () => {
      const listener = vi.fn();
      const tracker = new ImportProgressTracker(10, listener);

      tracker.update(5, 'current-file.txt');
      expect(tracker.snapshot().current).toBe('current-file.txt');

      tracker.clearCurrent();

      const progress = tracker.snapshot();
      expect(progress.current).toBeUndefined();
      expect(listener).toHaveBeenLastCalledWith({
        completed: 5,
        errors: [],
        total: 10,
      });
    });

    it('does not notify if current is already undefined', () => {
      const listener = vi.fn();
      const tracker = new ImportProgressTracker(10, listener);

      tracker.clearCurrent();

      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies only when current was defined', () => {
      const listener = vi.fn();
      const tracker = new ImportProgressTracker(10, listener);

      tracker.update(3, 'file.txt');
      listener.mockClear();

      tracker.clearCurrent();
      expect(listener).toHaveBeenCalledOnce();

      listener.mockClear();
      tracker.clearCurrent();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('snapshot', () => {
    it('returns immutable snapshot of current progress', () => {
      const tracker = new ImportProgressTracker(10);

      tracker.update(5);
      tracker.addError({ error: 'Error', file: 'test.txt' });

      const snapshot1 = tracker.snapshot();

      tracker.update(7);

      const snapshot2 = tracker.snapshot();

      // Original snapshot should not change
      expect(snapshot1.completed).toBe(5);
      expect(snapshot2.completed).toBe(7);
    });

    it('includes current file when present', () => {
      const tracker = new ImportProgressTracker(10);

      tracker.update(5, 'current.txt');

      const progress = tracker.snapshot();
      expect(progress.current).toBe('current.txt');
    });

    it('omits current field when not present', () => {
      const tracker = new ImportProgressTracker(10);

      tracker.update(5);

      const progress = tracker.snapshot();
      expect('current' in progress).toBe(false);
    });

    it('returns a copy of errors array', () => {
      const tracker = new ImportProgressTracker(10);

      tracker.addError({ error: 'Error', file: 'test.txt' });

      const snapshot1 = tracker.snapshot();
      const snapshot2 = tracker.snapshot();

      expect(snapshot1.errors).not.toBe(snapshot2.errors); // Different arrays
      expect(snapshot1.errors).toEqual(snapshot2.errors); // Same content
    });
  });

  describe('complete', () => {
    it('sets completed to total and returns final progress', () => {
      const tracker = new ImportProgressTracker(10);

      tracker.update(7);

      const final = tracker.complete();

      expect(final.completed).toBe(10);
      expect(final.total).toBe(10);
    });

    it('clears current file', () => {
      const tracker = new ImportProgressTracker(10);

      tracker.update(5, 'current.txt');

      const final = tracker.complete();

      expect(final.current).toBeUndefined();
    });

    it('preserves errors', () => {
      const tracker = new ImportProgressTracker(10);

      tracker.addError({ error: 'Failed', file: 'error.txt' });

      const final = tracker.complete();

      expect(final.errors).toHaveLength(1);
      expect(final.errors[0]).toEqual({ error: 'Failed', file: 'error.txt' });
    });

    it('returns snapshot with completed === total even if previously higher', () => {
      const tracker = new ImportProgressTracker(10);

      // This shouldn't happen in practice but test the behavior
      tracker.update(15); // Capped at 10

      const final = tracker.complete();

      expect(final.completed).toBe(10);
    });
  });

  describe('errorCount getter', () => {
    it('returns current error count', () => {
      const tracker = new ImportProgressTracker(10);

      expect(tracker.errorCount).toBe(0);

      tracker.addError({ error: 'Error 1', file: 'file1.txt' });
      expect(tracker.errorCount).toBe(1);

      tracker.addErrors([
        { error: 'Error 2', file: 'file2.txt' },
        { error: 'Error 3', file: 'file3.txt' },
      ]);
      expect(tracker.errorCount).toBe(3);
    });
  });

  describe('listener notification behavior', () => {
    it('does not call listener when none provided', () => {
      const tracker = new ImportProgressTracker(10);

      expect(() => {
        tracker.update(5);
        tracker.addError({ error: 'Error', file: 'test.txt' });
        tracker.clearCurrent();
      }).not.toThrow();
    });

    it('always provides fresh snapshot to listener', () => {
      const snapshots: ImportProgress[] = [];
      const listener = (progress: ImportProgress) => {
        snapshots.push(progress);
      };

      const tracker = new ImportProgressTracker(10, listener);

      tracker.update(1);
      tracker.update(2);
      tracker.addError({ error: 'Error', file: 'test.txt' });

      expect(snapshots).toHaveLength(3);
      expect(snapshots[0]?.completed).toBe(1);
      expect(snapshots[1]?.completed).toBe(2);
      expect(snapshots[2]?.errors).toHaveLength(1);
    });
  });

  describe('integration scenarios', () => {
    it('handles typical import flow', () => {
      const updates: ImportProgress[] = [];
      const listener = (progress: ImportProgress) => {
        updates.push(progress);
      };

      const tracker = new ImportProgressTracker(5, listener);

      // Start
      tracker.emitInitial();

      // Process files
      tracker.update(1, 'file1.txt');
      tracker.update(2, 'file2.txt');
      tracker.addError({ error: 'Failed to read', file: 'file3.txt' }); // This also triggers notification
      tracker.update(3, 'file4.txt');
      tracker.update(4, 'file5.txt');

      // Complete
      const final = tracker.complete();

      // emitInitial + 2 updates + addError + 2 more updates = 6 total
      expect(updates).toHaveLength(6);
      expect(final.completed).toBe(5);
      expect(final.errors).toHaveLength(1);
      expect(tracker.errorCount).toBe(1);
    });

    it('handles all-error scenario', () => {
      const tracker = new ImportProgressTracker(3);

      tracker.addErrors([
        { error: 'Error 1', file: 'file1.txt' },
        { error: 'Error 2', file: 'file2.txt' },
        { error: 'Error 3', file: 'file3.txt' },
      ]);

      const final = tracker.complete();

      expect(final.completed).toBe(3);
      expect(final.errors).toHaveLength(3);
      expect(tracker.errorCount).toBe(3);
    });

    it('handles partial progress with early completion', () => {
      const tracker = new ImportProgressTracker(100);

      tracker.update(50);
      const snapshot = tracker.complete();

      expect(snapshot.completed).toBe(100);
    });
  });
});
