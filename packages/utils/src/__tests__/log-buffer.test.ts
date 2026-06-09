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

  it('does not notify unsubscribed handlers and ignores subscriber failures', () => {
    const buffer = new LogBuffer({ size: 2 });
    const throwingHandler = vi.fn();
    const unsubscribedHandler = vi.fn();
    const activeHandler = vi.fn();

    buffer.subscribe(throwingHandler);
    const unsubscribe = buffer.subscribe(unsubscribedHandler);
    buffer.subscribe(activeHandler);
    unsubscribe();
    throwingHandler.mockImplementation(() => {
      throw new Error('subscriber failed');
    });

    buffer.push(createRecord(LogLevel.INFO, 'scope', 'event'));

    expect(throwingHandler).toHaveBeenCalledTimes(2);
    expect(unsubscribedHandler).toHaveBeenCalledTimes(1);
    expect(activeHandler).toHaveBeenLastCalledWith([expect.objectContaining({ message: 'event' })]);
  });

  it('clears records and enforces a minimum buffer size of one', () => {
    const buffer = new LogBuffer({ size: 0 });
    const handler = vi.fn();
    buffer.subscribe(handler);

    buffer.push(createRecord(LogLevel.INFO, 'scope', 'first'));
    buffer.push(createRecord(LogLevel.INFO, 'scope', 'second'));
    expect(buffer.getRecords()).toEqual([expect.objectContaining({ message: 'second' })]);

    buffer.clear();

    expect(buffer.getRecords()).toEqual([]);
    expect(handler).toHaveBeenLastCalledWith([]);
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

    it('trims the oldest record when resume skip message exceeds max size', () => {
      const buffer = new LogBuffer({ size: 1 });
      buffer.push(createRecord(LogLevel.INFO, 'a', 'before pause'));

      buffer.pause();
      buffer.push(createRecord(LogLevel.INFO, 'b', 'skipped'));
      buffer.resume();

      expect(buffer.getRecords()).toEqual([
        expect.objectContaining({
          message: expect.stringContaining('skipping 1 records'),
        }),
      ]);
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

    it('summarizes object shapes, long strings, arrays, and excess keys', () => {
      const buffer = new LogBuffer({ size: 10, skipArgCloning: true, maxArgSize: 8 });
      const obj = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `key${index}`,
          index === 0
            ? 'abcdefghijklmnopqrstuvwxyz'
            : index === 1
              ? [1, 2, 3]
              : index === 2
                ? () => 'value'
                : index,
        ])
      );

      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [obj, Symbol.for('event')]));

      const records = buffer.getRecords();
      const arg = records[0]?.args[0] as Record<string, unknown>;
      expect(arg['key0']).toBe('abcdefghijklmnopqrstuvwxyz'.slice(0, 100));
      expect(arg['key1']).toBe('[Array(3)]');
      expect(arg['key2']).toContain('value');
      expect(arg['...']).toBe('2 more keys');
      expect(records[0]?.args[1]).toBe('Symbol(event)');
    });

    it('truncates long top-level strings when cloning is skipped', () => {
      const buffer = new LogBuffer({ size: 10, skipArgCloning: true, maxArgSize: 4 });

      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', ['abcdef']));

      expect(buffer.getRecords()[0]?.args[0]).toBe('abcd... [truncated]');
    });

    it('preserves nullish and primitive args when cloning is skipped', () => {
      const buffer = new LogBuffer({ size: 10, skipArgCloning: true });

      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [null, undefined, 7, false]));

      expect(buffer.getRecords()[0]?.args).toEqual([null, undefined, 7, false]);
    });
  });

  describe('full cloning', () => {
    it('clones objects without size limits when maxArgSize is zero', () => {
      const buffer = new LogBuffer({ maxArgSize: 0 });
      const arg = { nested: { value: 1 }, list: [true, 'yes'] };

      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [arg]));

      expect(buffer.getRecords()[0]?.args[0]).toEqual(arg);
      expect(buffer.getRecords()[0]?.args[0]).not.toBe(arg);
    });

    it('stringifies unclonable objects when full cloning fails', () => {
      const buffer = new LogBuffer({ maxArgSize: 0 });
      const arg: Record<string, unknown> = {};
      arg['self'] = arg;

      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [arg]));

      expect(buffer.getRecords()[0]?.args[0]).toBe('[object Object]');
    });

    it('stringifies non-json values when full cloning rejects them', () => {
      const buffer = new LogBuffer({ maxArgSize: 0 });

      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [Symbol.for('event')]));

      expect(buffer.getRecords()[0]?.args[0]).toBe('Symbol(event)');
    });
  });

  describe('bounded cloning', () => {
    it('clones arrays and preserves nullish and primitive values within size limits', () => {
      const buffer = new LogBuffer({ maxArgSize: 1000 });
      const arg = ['value', 10, true, false, null, undefined];

      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [arg]));

      expect(buffer.getRecords()[0]?.args[0]).toEqual(arg);
      expect(buffer.getRecords()[0]?.args[0]).not.toBe(arg);
    });

    it('summarizes arrays when bounded cloning exceeds the size limit', () => {
      const buffer = new LogBuffer({ maxArgSize: 12 });
      const arg = ['abc', 'def', 'ghi', 'jkl'];

      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [arg]));

      expect(buffer.getRecords()[0]?.args[0]).toEqual({
        0: 'abc',
        1: 'def',
        2: 'ghi',
        3: 'jkl',
      });
    });

    it('summarizes objects when bounded cloning fails', () => {
      const buffer = new LogBuffer({ maxArgSize: 1000 });
      const throwingObject = {
        get value() {
          throw new Error('cannot read value');
        },
      };

      buffer.push(createRecord(LogLevel.INFO, 'test', 'msg', [throwingObject]));

      expect(buffer.getRecords()[0]?.args[0]).toBe('[object Object]');
    });
  });
});
