import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  formatGrepProjectionPageRange,
  formatProjectionShownCount,
  parseGrepContentProjectionPage,
  parseProjectionShownCount,
  ReadDeliverySchema,
  StringReplaceDeliverySchema,
} from '../context-provenance.js';

describe('projection formats read back by the thread context map', () => {
  it.each([
    { kept: 50, lowerBound: false, offset: 0, total: 61 },
    { kept: 11, lowerBound: false, offset: 50, total: 61 },
    { kept: 3, lowerBound: true, offset: 0, total: 200 },
    { kept: 0, lowerBound: false, offset: 50, total: 50 },
    { kept: 0, lowerBound: true, offset: 0, total: 0 },
  ])('round-trips a grep content page $offset+$kept/$total', (page) => {
    const header = `grep content ${formatGrepProjectionPageRange(page)} live=js-walk`;
    expect(parseGrepContentProjectionPage(`${header}\nsrc/a.ts\n  1: x`)).toEqual({
      kept: page.kept,
      offset: page.offset,
    });
  });

  it('reads nothing from text that is not a grep content page', () => {
    expect(parseGrepContentProjectionPage('grep files 1-12/12 matches=12')).toBeUndefined();
    expect(parseGrepContentProjectionPage('[pruned old tool result]')).toBeUndefined();
  });

  it('round-trips a list projection shown count from its header line only', () => {
    const header = `hybrid | set=s | ${formatProjectionShownCount(3, 9)} | truncated=false`;
    expect(parseProjectionShownCount(`${header}\n#1 a.ts`)).toBe(3);
    expect(parseProjectionShownCount('hybrid | set=s\nshown=2/3 in an excerpt')).toBeUndefined();
  });
});

describe('delivery schemas', () => {
  it('accept the fields a producer sends and keep extra ones', () => {
    const read = {
      approxOutputTokens: 8,
      content: '1: a',
      endLine: 1,
      nextCursor: null,
      path: 'src/a.ts',
      rootId: 'r',
      startLine: 1,
      totalLines: 1,
      truncated: false,
    };
    expect(
      Schema.decodeUnknownSync(ReadDeliverySchema, { errors: 'all', onExcessProperty: 'error' })(
        read
      )
    ).toEqual(read);
    expect(
      Schema.decodeUnknownResult(StringReplaceDeliverySchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })({ path: 'src/a.ts', replaced: true, rootId: 'r' })._tag === 'Success'
    ).toBe(true);
    expect(
      Schema.decodeUnknownResult(ReadDeliverySchema, { errors: 'all', onExcessProperty: 'error' })({
        path: 'src/a.ts',
      })._tag === 'Success'
    ).toBe(false);
  });
});
