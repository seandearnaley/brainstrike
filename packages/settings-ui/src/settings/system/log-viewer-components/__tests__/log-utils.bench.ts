import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { describe, test } from 'vitest';
import {
  createLogSearchHaystackCache,
  getCachedLogSearchHaystack,
  type LogRecordRow,
} from '../log-utils';

const RECORD_COUNT = 2000;
const SEARCH_TERMS = [
  'e',
  'el',
  'ele',
  'elec',
  'elect',
  'electr',
  'electron',
  'electron-',
  'electron-r',
  'electron-re',
  'electron-ren',
  'electron-renderer',
] as const;
const rows: readonly LogRecordRow[] = Array.from({ length: RECORD_COUNT }, (_, index) => {
  const record: LogRecord = {
    args: [],
    bindings: {},
    level: LogLevel.INFO,
    message: `message ${index} indexing completed`,
    scope: `worker-${index % 8}`,
    timestamp: index,
  };
  return {
    ...record,
    flattenedBindings: JSON.stringify({
      code: `code-${index % 11}`,
      runtime: index % 2 === 0 ? 'electron-main' : 'electron-renderer',
    }),
    originalRecord: record,
    serializedArgs: JSON.stringify({
      detail: 'x'.repeat(512),
      path: `/workspace/src/file-${index}.ts`,
    }),
  };
});
const EXPECTED_HITS = RECORD_COUNT * 10;

function buildLogSearchHaystack(row: LogRecordRow): string {
  return [row.message ?? '', row.scope ?? '', row.serializedArgs, row.flattenedBindings]
    .join(' ')
    .toLowerCase();
}

function assertExpectedHits(hits: number): void {
  if (hits !== EXPECTED_HITS) {
    throw new Error(`Unexpected benchmark checksum: ${hits}`);
  }
}

describe('incremental Log Viewer search over 2,000 retained records', () => {
  test('rebuilds the lowercase haystack for every term', async ({ bench }) => {
    await bench('rebuilds the lowercase haystack for every term', () => {
      let hits = 0;
      for (const term of SEARCH_TERMS) {
        for (const row of rows) {
          if (buildLogSearchHaystack(row).includes(term)) {
            hits += 1;
          }
        }
      }
      assertExpectedHits(hits);
    }).run();
  });

  test('caches lowercase haystacks within the viewer budget', async ({ bench }) => {
    await bench('caches lowercase haystacks within the viewer budget', () => {
      const cache = createLogSearchHaystackCache();
      let hits = 0;
      for (const term of SEARCH_TERMS) {
        for (const row of rows) {
          if (getCachedLogSearchHaystack(row, cache).includes(term)) {
            hits += 1;
          }
        }
      }
      assertExpectedHits(hits);
    }).run();
  });
});
