import type { DatabaseInitPhaseReport } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  isDbHostProgressEnvelope,
  isDbHostToMainMessage,
  parseDbHostProgressEnvelope,
} from '../../db-host-protocol';

describe('isDbHostToMainMessage', () => {
  it.each([
    { kind: 'log', level: 'info', message: 'DB host process started' },
    { id: 'r', kind: 'response', ok: true },
    { kind: 'live-update', liveId: 'live:1', results: { rows: [] } },
  ])('accepts a $kind message', (message) => {
    expect(isDbHostToMainMessage(message)).toBe(true);
  });

  it.each([null, undefined, 'lifecycle', 7, {}, { kind: 3 }])('rejects %j', (value) => {
    expect(isDbHostToMainMessage(value)).toBe(false);
  });

  describe('lifecycle', () => {
    it.each(['closing', 'closed', 'close-failed'] as const)('accepts state %s', (state) => {
      expect(isDbHostToMainMessage({ kind: 'lifecycle', reason: 'SIGINT', state })).toBe(true);
    });

    it.each(['request', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const)('accepts reason %s', (reason) => {
      expect(isDbHostToMainMessage({ kind: 'lifecycle', reason, state: 'closing' })).toBe(true);
    });

    it('accepts a close-failed message that carries its error', () => {
      expect(
        isDbHostToMainMessage({
          error: { message: 'checkpoint failed' },
          kind: 'lifecycle',
          reason: 'SIGTERM',
          state: 'close-failed',
        })
      ).toBe(true);
    });

    it.each([
      ['no state', { kind: 'lifecycle', reason: 'SIGINT' }],
      ['no reason', { kind: 'lifecycle', state: 'closing' }],
      ['an unknown state', { kind: 'lifecycle', reason: 'SIGINT', state: 'opening' }],
      ['an unknown reason', { kind: 'lifecycle', reason: 'SIGUSR1', state: 'closing' }],
      ['a non-string reason', { kind: 'lifecycle', reason: 2, state: 'closing' }],
      ['a non-string state', { kind: 'lifecycle', reason: 'SIGINT', state: ['closing'] }],
    ])('rejects a message with %s', (_name, message) => {
      expect(isDbHostToMainMessage(message)).toBe(false);
    });
  });
});

const INDEX = {
  accessMethod: 'bm25',
  heapBytes: 137_047_040,
  index: 'idx_file_chunks_content_bm25',
  indexBytes: 33_685_504,
  schema: 'public',
  table: 'file_chunks',
  toastBytes: 221_675_520,
} as const;

function progress(report: unknown, overrides: Record<string, unknown> = {}): unknown {
  return { id: 'db-host:1', kind: 'progress', report, ...overrides };
}

describe('isDbHostProgressEnvelope', () => {
  it.each<DatabaseInitPhaseReport>([
    { pgWalBytes: 0, phase: 'open-database' },
    { pgWalBytes: 954_204_160, phase: 'open-database' },
    { index: INDEX, phase: 'index-rebuild' },
    { index: { ...INDEX, heapBytes: 0, indexBytes: 0, toastBytes: 0 }, phase: 'index-rebuild' },
    { phase: 'migration' },
  ])('accepts a well-formed %j report', (report) => {
    expect(isDbHostProgressEnvelope(progress(report))).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'progress'],
    ['a response envelope', { id: 'db-host:1', kind: 'response', ok: true }],
    ['a missing id', progress({ phase: 'migration' }, { id: undefined })],
    ['an empty id', progress({ phase: 'migration' }, { id: '' })],
    ['a numeric id', progress({ phase: 'migration' }, { id: 7 })],
    ['a missing report', progress(undefined)],
    ['a null report', progress(null)],
    ['an unknown phase', progress({ phase: 'load-extensions' })],
    ['a phase that is not a string', progress({ phase: 3 })],
    ['open-database without pgWalBytes', progress({ phase: 'open-database' })],
    ['index-rebuild without an index', progress({ phase: 'index-rebuild' })],
    ['index-rebuild with a null index', progress({ index: null, phase: 'index-rebuild' })],
  ])('rejects %s', (_label, value) => {
    expect(isDbHostProgressEnvelope(value)).toBe(false);
  });

  it.each([
    ['a string', 'big'],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', 2 ** 53],
    ['a bigint', 5n],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s as a byte count, in every field that carries one', (_label, bytes) => {
    expect(isDbHostProgressEnvelope(progress({ pgWalBytes: bytes, phase: 'open-database' }))).toBe(
      false
    );
    for (const field of ['heapBytes', 'indexBytes', 'toastBytes'] as const) {
      expect(
        isDbHostProgressEnvelope(
          progress({ index: { ...INDEX, [field]: bytes }, phase: 'index-rebuild' })
        )
      ).toBe(false);
    }
  });

  it.each(['accessMethod', 'index', 'schema', 'table'] as const)(
    'rejects an index whose %s is missing or empty',
    (field) => {
      expect(
        isDbHostProgressEnvelope(
          progress({ index: { ...INDEX, [field]: '' }, phase: 'index-rebuild' })
        )
      ).toBe(false);
      expect(
        isDbHostProgressEnvelope(
          progress({ index: { ...INDEX, [field]: undefined }, phase: 'index-rebuild' })
        )
      ).toBe(false);
    }
  );

  it.each(['accessMethod', 'index', 'schema', 'table'] as const)(
    'accepts a %s of 63 UTF-8 bytes (a PostgreSQL identifier) and rejects one byte more',
    (field) => {
      const withName = (name: string) =>
        isDbHostProgressEnvelope(
          progress({ index: { ...INDEX, [field]: name }, phase: 'index-rebuild' })
        );
      expect(withName('a'.repeat(63))).toBe(true);
      expect(withName('a'.repeat(64))).toBe(false);
      // Bytes, not characters: 32 two-byte characters are 64 bytes.
      expect(withName('é'.repeat(31))).toBe(true);
      expect(withName('é'.repeat(32))).toBe(false);
    }
  );

  it.each([
    ['a line feed', 'idx\nfake'],
    ['a carriage return', 'idx\rfake'],
    ['a NUL', 'idx\u0000'],
    ['a C1 control', 'idx\u0085'],
    ['a right-to-left override', 'idx\u202Egnp.exe'],
    ['a bidi isolate', 'idx\u2066x'],
    ['a line separator', 'idx\u2028fake'],
    ['a paragraph separator', 'idx\u2029fake'],
    ['an Arabic letter mark', 'idx\u061Cx'],
    ['a zero-width space', 'idx\u200Bx'],
    ['a zero-width joiner', 'idx\u200Dx'],
    ['a byte-order mark', '\uFEFFidx'],
  ])(
    'rejects an identifier containing %s, which could forge the one-line error a person reads',
    (_label, name) => {
      for (const field of ['accessMethod', 'index', 'schema', 'table'] as const) {
        expect(
          isDbHostProgressEnvelope(
            progress({ index: { ...INDEX, [field]: name }, phase: 'index-rebuild' })
          )
        ).toBe(false);
      }
    }
  );
});

describe('parseDbHostProgressEnvelope', () => {
  it('rebuilds the envelope from its known fields only, dropping anything extra the host sent', () => {
    const parsed = parseDbHostProgressEnvelope(
      progress(
        {
          extraOnReport: 'secret-report-text',
          index: { ...INDEX, rows: ['secret-row-content'] },
          phase: 'index-rebuild',
        },
        { extraOnEnvelope: 'secret-envelope-text' }
      )
    );

    expect(parsed).toEqual(progress({ index: INDEX, phase: 'index-rebuild' }));
    expect(JSON.stringify(parsed)).not.toMatch(/secret/u);
  });

  it('returns null for anything the guard rejects', () => {
    expect(parseDbHostProgressEnvelope(progress({ phase: 'load-extensions' }))).toBeNull();
  });
});
