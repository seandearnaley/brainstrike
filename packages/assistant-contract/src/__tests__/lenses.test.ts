import { describe, expect, it } from 'vitest';
import {
  coerceLensValues,
  deriveLensId,
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
  '-- target: index',
  '-- param: symbol text  Seed symbol name',
  '-- param: depth integer  Max traversal depth',
  'SELECT name FROM file_symbols WHERE name = $1 AND start_line < $2',
].join('\n');

describe('parseLensFile', () => {
  it('retains an explicit caller-vector requirement tied to a declared text seed', () => {
    const parsed = parseLensFile(
      'custom-name.sql',
      VALID.replace('-- target: index', '-- target: index\n-- requires: caller-vectors symbol')
    );
    expect(parsed.ok && parsed.lens).toMatchObject({
      requirement: { kind: 'caller-vectors', seedParam: 'symbol' },
    });
  });

  it.each([
    ['unknown requirement', '-- requires: other symbol'],
    ['missing seed name', '-- requires: caller-vectors'],
    ['undeclared seed', '-- requires: caller-vectors missing'],
    ['non-text seed', '-- requires: caller-vectors depth'],
    [
      'duplicate requirement',
      '-- requires: caller-vectors symbol\n-- requires: caller-vectors symbol',
    ],
  ])('rejects %s visibly', (_label, declaration) => {
    const parsed = parseLensFile(
      'custom-name.sql',
      VALID.replace('-- target: index', `-- target: index\n${declaration}`)
    );
    expect(parsed.ok).toBe(false);
  });

  it('rejects caller-vector requirements on the app target', () => {
    const parsed = parseLensFile(
      'custom-name.sql',
      VALID.replace('-- target: index', '-- target: app\n-- requires: caller-vectors symbol')
    );
    expect(parsed.ok).toBe(false);
  });

  it.each(['app', 'index'])('requires and retains the explicit %s lens target', (target) => {
    const result = parseLensFile(
      'routed.sql',
      `-- description: Routed query\n-- target: ${target}\nSELECT 1`
    );
    expect(result.ok && result.lens).toMatchObject({ target });
  });

  it.each([
    ['missing', '-- description: Routed query\nSELECT 1'],
    ['empty', '-- description: Routed query\n-- target:\nSELECT 1'],
    ['invalid', '-- description: Routed query\n-- target: state\nSELECT 1'],
    ['duplicate same', '-- description: Routed query\n-- target: app\n-- target: app\nSELECT 1'],
    [
      'duplicate conflicting',
      '-- description: Routed query\n-- target: app\n-- target: index\nSELECT 1',
    ],
    ['SQL body directive', '-- description: Routed query\nSELECT 1\n-- target: app'],
  ])('rejects a %s target with a visible parse error', (_label, content) => {
    const result = parseLensFile('routed.sql', content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/target/i);
    }
  });

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
      '-- description: Row counts\n-- target: app\nSELECT count(*) FROM file_records'
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ['missing description', 'SELECT 1', /description/i],
    ['empty description', '-- description:\nSELECT 1', /description/i],
    ['duplicate description', '-- description: a\n-- description: b\nSELECT 1', /description/i],
    [
      'unknown param type',
      '-- description: d\n-- target: app\n-- param: x uuid  nope\nSELECT $1',
      /type/i,
    ],
    [
      'bad param name',
      '-- description: d\n-- target: app\n-- param: Bad-Name text\nSELECT $1',
      /param/i,
    ],
    [
      'duplicate param name',
      '-- description: d\n-- target: app\n-- param: a text\n-- param: a text\nSELECT $1 || $2',
      /duplicate/i,
    ],
    [
      'malformed param line',
      '-- description: d\n-- target: app\n-- param: onlyname\nSELECT 1',
      /param/i,
    ],
    ['empty SQL body', '-- description: d\n-- target: app\n-- param: a text\n', /sql/i],
    [
      'placeholder beyond declared params',
      '-- description: d\n-- target: app\n-- param: a text\nSELECT $1, $2',
      /\$2/,
    ],
    [
      'declared param never referenced',
      '-- description: d\n-- target: app\n-- param: a text\n-- param: b text\nSELECT $1',
      /\$2|unused|b/i,
    ],
    ['$0 placeholder', '-- description: d\n-- target: app\nSELECT $0', /\$0/],
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
    const content = `-- description: d\n-- target: app\n${params.join('\n')}\nSELECT ${refs.join(', ')}`;
    const result = parseLensFile('lens.sql', content);
    expect(result.ok).toBe(false);
  });

  it('rejects SQL over the char cap', () => {
    const content = `-- description: d\n-- target: app\nSELECT '${'x'.repeat(MAX_USER_LENS_SQL_CHARS)}'`;
    const result = parseLensFile('lens.sql', content);
    expect(result.ok).toBe(false);
  });

  it('a placeholder inside a -- comment does not count (commented-out fragments)', () => {
    const content = [
      '-- description: d',
      '-- target: app',
      '-- param: a text',
      'SELECT $1',
      '-- was: AND depth < $2 (dropped in review)',
    ].join('\n');
    const result = parseLensFile('lens.sql', content);
    expect(result.ok).toBe(true);
  });

  it('keeps interior comments as part of the SQL body', () => {
    const content = [
      '-- description: d',
      '-- target: app',
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

describe('deriveLensId', () => {
  it('derives the stem and agrees with parseLensFile', () => {
    const derived = deriveLensId('callers-hybrid.sql');
    expect(derived).toEqual({ id: 'callers-hybrid', ok: true });

    const parsed = parseLensFile('callers-hybrid.sql', VALID);
    expect(parsed.ok && parsed.lens.id).toBe('callers-hybrid');
  });

  it.each([
    ['uppercase stem', 'MyLens.sql'],
    ['uppercase extension with uppercase stem', 'MyLens.SQL'],
    ['non-sql extension', 'lens.txt'],
  ])('rejects %s — the loader must not reserve an id the parser refuses', (_label, fileName) => {
    // The drift this function exists to remove: the loader once accepted
    // `MyLens.SQL` as the id `MyLens` while the parser rejected the file, so
    // the reserved key and the real id disagreed (BST-936).
    expect(deriveLensId(fileName).ok).toBe(false);
    expect(parseLensFile(fileName, VALID).ok).toBe(false);
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
