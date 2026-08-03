import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { describe, expect, it } from 'vitest';
import { getCachedLogSearchHaystack, type LogRecordRow } from '../log-utils';

describe('getCachedLogSearchHaystack', () => {
  it('builds the lowercase projection once per record across incremental searches', () => {
    let stringCoercions = 0;
    const countedPayload = {
      toString: () => {
        stringCoercions += 1;
        return 'Needle payload';
      },
    };
    const record: LogRecord = {
      args: [],
      bindings: {},
      level: LogLevel.INFO,
      message: 'Searchable record',
      timestamp: 1,
    };
    const row: LogRecordRow = {
      ...record,
      flattenedBindings: '{}',
      originalRecord: record,
      serializedArgs: countedPayload as unknown as string,
    };
    const cache = new WeakMap<LogRecord, string>();

    expect(getCachedLogSearchHaystack(row, cache)).toContain('needle');
    expect(getCachedLogSearchHaystack(row, cache)).toContain('searchable');
    expect(stringCoercions).toBe(1);
  });
});
