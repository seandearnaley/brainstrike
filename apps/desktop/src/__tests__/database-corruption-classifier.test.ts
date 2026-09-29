import { describe, expect, it } from 'vitest';
import { classifyDatabaseCorruption, isCorruptionError } from '../database-corruption-classifier';

function codedError(code: string, message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...fields });
}

describe('classifyDatabaseCorruption', () => {
  it.each([
    { code: 'XX001', message: 'invalid page in block 7 of relation base/5/123' },
    { code: 'XX002', message: "right sibling's left-link doesn't match" },
  ] as const)('classifies SQLSTATE $code as corruption', ({ code, message }) => {
    expect(classifyDatabaseCorruption(codedError(code, message))).toEqual({
      message,
      sqlstate: code,
    });
  });

  it('copies the identifier-only Postgres fields when present', () => {
    const error = codedError('XX002', 'index "idx" contains unexpected zero page', {
      detail: 'Key (secret)=(user row data) is broken.',
      file: 'nbtpage.c',
      routine: '_bt_checkpage',
      schema: 'public',
      table: 'brainstrike_chunks',
      where: 'SQL statement "SELECT secret FROM t"',
    });

    expect(classifyDatabaseCorruption(error)).toEqual({
      file: 'nbtpage.c',
      message: 'index "idx" contains unexpected zero page',
      routine: '_bt_checkpage',
      schema: 'public',
      sqlstate: 'XX002',
      table: 'brainstrike_chunks',
    });
  });

  it('ignores non-string identifier fields instead of guessing', () => {
    const error = codedError('XX001', 'corrupt', { file: 42, routine: null, table: {} });

    expect(classifyDatabaseCorruption(error)).toEqual({ message: 'corrupt', sqlstate: 'XX001' });
  });

  it('classifies a plain object with a corruption code', () => {
    expect(classifyDatabaseCorruption({ code: 'XX001', message: 'boom' })).toEqual({
      message: 'boom',
      sqlstate: 'XX001',
    });
  });

  it('classifies a corruption SQLSTATE preserved as an ES2022 cause', () => {
    const original = codedError('XX001', 'invalid page index at block 2753');
    const wrapped = new Error('maintenance pass failed', { cause: original });

    expect(classifyDatabaseCorruption(wrapped)).toEqual({
      message: 'invalid page index at block 2753',
      sqlstate: 'XX001',
    });
    expect(
      isCorruptionError(new Error('outer', { cause: new Error('middle', { cause: original }) }))
    ).toBe(true);
  });

  it('stops following causes past the depth bound and on a cycle', () => {
    let deep: Error = codedError('XX001', 'too deep');
    for (let level = 0; level < 6; level += 1) {
      deep = new Error(`wrapper ${level}`, { cause: deep });
    }
    expect(classifyDatabaseCorruption(deep)).toBeNull();

    const cyclic: Error & { cause?: unknown } = new Error('cycle');
    cyclic.cause = cyclic;
    expect(classifyDatabaseCorruption(cyclic)).toBeNull();
  });

  it('names the SQLSTATE when the error carries no message', () => {
    expect(classifyDatabaseCorruption({ code: 'XX002' })).toEqual({
      message: 'SQLSTATE XX002',
      sqlstate: 'XX002',
    });
  });

  it.each([
    ['XX000 (internal_error is too broad)', codedError('XX000', 'internal error')],
    [
      'the routine crash-recovery log line without a code',
      new Error('database system was interrupted; last known up at 2026-09-29 10:00:00 UTC'),
    ],
    [
      'a corruption-looking message without a code',
      new Error('invalid page in block 7 of relation base/5/123'),
    ],
    [
      'a checkpoint message without a code',
      new Error('could not locate a valid checkpoint record'),
    ],
    [
      'user text echoing a corruption phrase under an unrelated SQLSTATE',
      codedError(
        '22P02',
        `invalid input syntax for type json: "right sibling's left-link doesn't match"`
      ),
    ],
    [
      'a corruption-looking message under a non-corruption SQLSTATE',
      codedError('58030', 'invalid page in block 1 of relation base/5/1'),
    ],
    ['a lowercase corruption code', codedError('xx001', 'corrupt')],
    ['a non-string code', Object.assign(new Error('corrupt'), { code: 1 })],
  ])('does not classify %s', (_label, error) => {
    expect(classifyDatabaseCorruption(error)).toBeNull();
    expect(isCorruptionError(error)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['the string XX001', 'XX001'],
    ['a number', 42],
    ['an empty object', {}],
  ])('does not classify non-error input: %s', (_label, input) => {
    expect(classifyDatabaseCorruption(input)).toBeNull();
    expect(isCorruptionError(input)).toBe(false);
  });
});

describe('isCorruptionError', () => {
  it('is true exactly when a signal is classified', () => {
    expect(isCorruptionError(codedError('XX001', 'a'))).toBe(true);
    expect(isCorruptionError(codedError('XX002', 'b'))).toBe(true);
    expect(isCorruptionError(codedError('XX000', 'c'))).toBe(false);
  });
});
