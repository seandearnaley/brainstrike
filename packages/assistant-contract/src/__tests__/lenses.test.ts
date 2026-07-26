import { describe, expect, it } from 'vitest';
import {
  coerceLensValues,
  MAX_USER_LENS_PARAMS,
  MAX_USER_LENS_SQL_CHARS,
  parseLensFile,
} from '../lenses.js';

/**
 * Lens format parser (BST-921). A lens is a repo file and therefore UNTRUSTED
 * input; every case below that is not a clean parse must produce a structured
 * error — never a throw, never a silent fix-up — mirroring the persona
 * parser's posture.
 */

const VALID = [
  '-- description: Hybrid retrieval over a symbol caller graph',
  '-- param: symbol text  Seed symbol name',
  '-- param: depth integer  Max traversal depth',
  'SELECT name FROM file_symbols WHERE name = $1 AND start_line < $2',
].join('\n');

describe('parseLensFile', () => {
  it('parses a valid lens with ordered params', () => {
    const result = parseLensFile('callers-hybrid.sql', VALID);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.lens.id).toBe('callers-hybrid');
    expect(result.lens.description).toBe('Hybrid retrieval over a symbol caller graph');
    expect(result.lens.params).toEqual([
      { description: 'Seed symbol name', name: 'symbol', type: 'text' },
      { description: 'Max traversal depth', name: 'depth', type: 'integer' },
    ]);
    expect(result.lens.sql).toContain('SELECT name FROM file_symbols');
  });

  it('parses a zero-param lens', () => {
    const result = parseLensFile(
      'counts.sql',
      '-- description: Row counts\nSELECT count(*) FROM file_records'
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ['missing description', 'SELECT 1', /description/i],
    ['empty description', '-- description:\nSELECT 1', /description/i],
    ['duplicate description', '-- description: a\n-- description: b\nSELECT 1', /description/i],
    ['unknown param type', '-- description: d\n-- param: x uuid  nope\nSELECT $1', /type/i],
    ['bad param name', '-- description: d\n-- param: Bad-Name text\nSELECT $1', /param/i],
    [
      'duplicate param name',
      '-- description: d\n-- param: a text\n-- param: a text\nSELECT $1 || $2',
      /duplicate/i,
    ],
    ['malformed param line', '-- description: d\n-- param: onlyname\nSELECT 1', /param/i],
    ['empty SQL body', '-- description: d\n-- param: a text\n', /sql/i],
    [
      'placeholder beyond declared params',
      '-- description: d\n-- param: a text\nSELECT $1, $2',
      /\$2/,
    ],
    [
      'declared param never referenced',
      '-- description: d\n-- param: a text\n-- param: b text\nSELECT $1',
      /\$2|unused|b/i,
    ],
    ['$0 placeholder', '-- description: d\nSELECT $0', /\$0/],
  ])('rejects %s', (_label, content, pattern) => {
    const result = parseLensFile('lens.sql', content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(pattern);
    }
  });

  it.each([
    ['uppercase', 'MyLens.sql'],
    ['underscore', 'my_lens.sql'],
    ['leading dash', '-lens.sql'],
    ['non-sql extension', 'lens.txt'],
    ['too long', `${'a'.repeat(65)}.sql`],
  ])('rejects a %s filename', (_label, fileName) => {
    const result = parseLensFile(fileName, VALID);
    expect(result.ok).toBe(false);
  });

  it('rejects more than MAX_USER_LENS_PARAMS params', () => {
    const params = Array.from(
      { length: MAX_USER_LENS_PARAMS + 1 },
      (_, i) => `-- param: p${i} text`
    );
    const refs = Array.from({ length: MAX_USER_LENS_PARAMS + 1 }, (_, i) => `$${i + 1}`);
    const content = `-- description: d\n${params.join('\n')}\nSELECT ${refs.join(', ')}`;
    const result = parseLensFile('lens.sql', content);
    expect(result.ok).toBe(false);
  });

  it('rejects SQL over the char cap', () => {
    const content = `-- description: d\nSELECT '${'x'.repeat(MAX_USER_LENS_SQL_CHARS)}'`;
    const result = parseLensFile('lens.sql', content);
    expect(result.ok).toBe(false);
  });

  it('keeps interior comments as part of the SQL body', () => {
    const content = [
      '-- description: d',
      '-- param: a text',
      'SELECT $1 AS v',
      '-- an interior comment, NOT a header line',
      'FROM file_records',
    ].join('\n');
    const result = parseLensFile('lens.sql', content);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.lens.sql).toContain('interior comment');
  });
});

describe('coerceLensValues', () => {
  const params = [
    { description: '', name: 'symbol', type: 'text' as const },
    { description: '', name: 'depth', type: 'integer' as const },
    { description: '', name: 'ratio', type: 'number' as const },
    { description: '', name: 'exported', type: 'boolean' as const },
  ];

  it('coerces each declared type from its string form', () => {
    const result = coerceLensValues(params, ['startWorker', '10', '0.5', 'true']);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.values).toEqual(['startWorker', 10, 0.5, true]);
  });

  it.each([
    ['count mismatch', ['a', '1', '0.5']],
    ['non-integer for integer', ['a', '1.5', '0.5', 'true']],
    ['non-numeric for number', ['a', '1', 'abc', 'true']],
    ['non-boolean for boolean', ['a', '1', '0.5', 'yes']],
  ])('rejects %s naming the param', (_label, values) => {
    const result = coerceLensValues(params, values);
    expect(result.ok).toBe(false);
  });

  it('text values pass through untouched — including injection shapes', () => {
    const hostile = `'; DROP TABLE file_records; --`;
    const result = coerceLensValues([params[0]!], [hostile]);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.values).toEqual([hostile]);
  });
});
