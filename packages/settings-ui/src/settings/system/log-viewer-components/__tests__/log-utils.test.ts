import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { describe, expect, it } from 'vitest';
import {
  createLogSearchHaystackCache,
  getCachedLogSearchHaystack,
  type LogRecordRow,
  MAX_CACHED_LOG_SEARCH_HAYSTACK_CHARACTERS,
  serializeBindings,
} from '../log-utils';

describe('serializeBindings', () => {
  it('surfaces a toJSON result of undefined instead of silently omitting bindings', () => {
    expect(serializeBindings({ toJSON: () => undefined })).toBe('[Bindings serialization failed]');
  });
});

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
    const cache = createLogSearchHaystackCache();

    expect(getCachedLogSearchHaystack(row, cache)).toContain('needle');
    expect(getCachedLogSearchHaystack(row, cache)).toContain('searchable');
    expect(stringCoercions).toBe(1);
  });

  it('does not retain more than the viewer search cache budget', () => {
    const record: LogRecord = {
      args: [],
      bindings: {},
      level: LogLevel.INFO,
      message: 'x'.repeat(MAX_CACHED_LOG_SEARCH_HAYSTACK_CHARACTERS),
      timestamp: 1,
    };
    const row: LogRecordRow = {
      ...record,
      flattenedBindings: '{}',
      originalRecord: record,
      serializedArgs: '',
    };
    const cache = createLogSearchHaystackCache();

    expect(getCachedLogSearchHaystack(row, cache)).toHaveLength(
      MAX_CACHED_LOG_SEARCH_HAYSTACK_CHARACTERS + 5
    );
    expect(cache.haystacks.has(record)).toBe(false);
    expect(cache.cachedCharacters).toBe(0);
  });

  it('resets its budget for a replacement record snapshot', () => {
    const firstRecord: LogRecord = {
      args: [],
      bindings: {},
      level: LogLevel.INFO,
      message: 'First snapshot',
      timestamp: 1,
    };
    const replacementRecord: LogRecord = {
      ...firstRecord,
      message: 'Replacement snapshot',
      timestamp: 2,
    };
    const firstRow: LogRecordRow = {
      ...firstRecord,
      flattenedBindings: '{}',
      originalRecord: firstRecord,
      serializedArgs: '',
    };
    const replacementRow: LogRecordRow = {
      ...replacementRecord,
      flattenedBindings: '{}',
      originalRecord: replacementRecord,
      serializedArgs: '',
    };
    const cache = createLogSearchHaystackCache();

    cache.resetFor([firstRecord]);
    getCachedLogSearchHaystack(firstRow, cache);
    expect(cache.cachedCharacters).toBeGreaterThan(0);

    cache.resetFor([replacementRecord]);
    expect(cache.cachedCharacters).toBe(0);
    expect(getCachedLogSearchHaystack(replacementRow, cache)).toContain('replacement');
    expect(cache.haystacks.has(replacementRecord)).toBe(true);
  });
});
