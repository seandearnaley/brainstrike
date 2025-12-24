import { describe, expect, it, vi } from 'vitest';
import { LogBuffer } from '../../src/log-buffer';
import { LogLevel } from '../../src/logger';

const createRecord = (level: LogLevel, scope: string, message: string, args: unknown[] = []) => ({
  level,
  scope,
  message,
  timestamp: Date.now(),
  args,
  bindings: {},
});

describe('LogBuffer', () => {
  it('retains most recent records up to max size', () => {
    const buffer = new LogBuffer({ size: 3 });
    buffer.push(createRecord(LogLevel.INFO, 'a', 'first'));
    buffer.push(createRecord(LogLevel.WARN, 'b', 'second'));
    buffer.push(createRecord(LogLevel.ERROR, 'c', 'third'));
    buffer.push(createRecord(LogLevel.DEBUG, 'd', 'fourth'));

    const records = buffer.getRecords();
    expect(records).toHaveLength(3);
    expect(records[0]?.message).toBe('second');
    expect(records[2]?.message).toBe('fourth');
  });

  it('notifies subscribers on update', () => {
    const buffer = new LogBuffer({ size: 2 });
    const handler = vi.fn();
    const unsubscribe = buffer.subscribe(handler);
    buffer.push(createRecord(LogLevel.INFO, 'scope', 'event'));
    expect(handler).toHaveBeenCalledTimes(2); // initial + update
    expect(handler.mock.calls[1]?.[0]?.[0]?.message).toBe('event');
    unsubscribe();
  });

  describe('pause/resume', () => {
    it('discards records while paused', () => {
      const buffer = new LogBuffer({ size: 10 });
      buffer.push(createRecord(LogLevel.INFO, 'a', 'before pause'));

      buffer.pause();
      expect(buffer.isPaused()).toBe(true);

      buffer.push(createRecord(LogLevel.INFO, 'b', 'during pause 1'));
      buffer.push(createRecord(LogLevel.INFO, 'c', 'during pause 2'));

      const recordsDuringPause = buffer.getRecords();
      expect(recordsDuringPause).toHaveLength(1);
      expect(recordsDuringPause[0]?.message).toBe('before pause');
      expect(buffer.getSkippedCount()).toBe(2);
    });

    it('resumes recording after resume()', () => {
      const buffer = new LogBuffer({ size: 10 });
      buffer.push(createRecord(LogLevel.INFO, 'a', 'before'));

      buffer.pause();
      buffer.push(createRecord(LogLevel.INFO, 'b', 'skipped'));
      buffer.resume();

      expect(buffer.isPaused()).toBe(false);

      buffer.push(createRecord(LogLevel.INFO, 'c', 'after'));

      const records = buffer.getRecords();
      // Should have: before, resume message, after
      expect(records.length).toBeGreaterThanOrEqual(2);
      expect(records.at(-1)?.message).toBe('after');
    });

    it('logs skip count message on resume if records were skipped', () => {
      const buffer = new LogBuffer({ size: 10 });

      buffer.pause();
      buffer.push(createRecord(LogLevel.INFO, 'a', 'skipped 1'));
      buffer.push(createRecord(LogLevel.INFO, 'b', 'skipped 2'));
      buffer.push(createRecord(LogLevel.INFO, 'c', 'skipped 3'));
      buffer.resume();

      const records = buffer.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.message).toContain('skipping 3 records');
    });

    it('does not log skip message if no records were skipped', () => {
      const buffer = new LogBuffer({ size: 10 });

      buffer.pause();
      buffer.resume();

      const records = buffer.getRecords();
      expect(records).toHaveLength(0);
    });
  });

  describe('arg size limiting', () => {
    it('truncates large string args', () => {
      const buffer = new LogBuffer({ size: 10, maxArgSize: 50 });
      const longString = 'a'.repeat(100);
      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [longString]));

      const records = buffer.getRecords();
      const arg = records[0]?.args[0] as string;
      expect(arg.length).toBeLessThan(100);
      expect(arg).toContain('[truncated]');
    });

    it('summarizes large objects', () => {
      const buffer = new LogBuffer({ size: 10, maxArgSize: 50 });
      const largeObject = {
        key1: 'value1',
        key2: 'value2',
        nested: { deep: { object: 'here' } },
        array: [1, 2, 3, 4, 5],
      };
      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [largeObject]));

      const records = buffer.getRecords();
      const arg = records[0]?.args[0] as Record<string, unknown>;
      expect(typeof arg).toBe('object');
      // Nested objects should be summarized
      expect(arg['nested']).toBe('{Object}');
      expect(arg['array']).toBe('[Array(5)]');
    });

    it('preserves primitive values', () => {
      const buffer = new LogBuffer({ size: 10, maxArgSize: 1000 });
      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [42, true, null, undefined]));

      const records = buffer.getRecords();
      expect(records[0]?.args).toEqual([42, true, null, undefined]);
    });
  });

  describe('skipArgCloning option', () => {
    it('summarizes args when skipArgCloning is true', () => {
      const buffer = new LogBuffer({ size: 10, skipArgCloning: true, maxArgSize: 100 });
      const obj = { name: 'test', data: { nested: 'value' } };
      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [obj]));

      const records = buffer.getRecords();
      const arg = records[0]?.args[0] as Record<string, unknown>;
      expect(arg['name']).toBe('test');
      expect(arg['data']).toBe('{Object}');
    });
  });
});
