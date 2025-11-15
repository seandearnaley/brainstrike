import { describe, expect, it, vi } from 'vitest';
import { LogBuffer } from '../../src/log-buffer';
import { LogLevel } from '../../src/logger';

const createRecord = (level: LogLevel, scope: string, message: string) => ({
  level,
  scope,
  message,
  timestamp: Date.now(),
  args: [],
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
});
