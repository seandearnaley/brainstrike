import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SqliteGrepOptions } from '../protocol.js';
import { SqliteSandbox } from '../sandbox.js';

let directory: string;
let writer: DatabaseSync;
let sandbox: SqliteSandbox;
let transferredRows: number;
const defaults: SqliteGrepOptions = {
  caseSensitive: true,
  isRegex: false,
  maxRows: 100,
  pattern: 'needle',
  rootIds: ['authorized'],
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'brainstrike-literal-grep-'));
  const path = join(directory, 'index.sqlite');
  writer = new DatabaseSync(path);
  // No affinity: exercise the decoder's contract even for malformed native rows.
  writer.exec(`CREATE TABLE index_metadata(singleton,schema_version,store_id,index_mode,profile_json,profile_hash);
    INSERT INTO index_metadata VALUES(1,8,'${'a'.repeat(64)}','text-only',NULL,NULL);
    CREATE TABLE file_records(id,root_id,path,embedding_set_id,source_path);
    INSERT INTO file_records VALUES('selected','authorized','a.ts','collection','source'),
      ('other','unauthorized','b.ts','other','other'),('retained',NULL,NULL,'collection',NULL);
    CREATE TABLE file_chunks(id,root_id,file_record_id,content,content_hash,start_line,end_line,chunk_index,chunk_size,chunk_type,start_offset,end_offset,token_count);`);
  sandbox = new SqliteSandbox(path);
  transferredRows = 0;
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql: string
  ): StatementSync {
    const statement = prepare.call(this, sql);
    if (sql.includes('native_chunks')) {
      const iterate = statement.iterate;
      vi.spyOn(statement, 'iterate').mockImplementation(function* (
        ...parameters
      ): Generator<Record<string, SQLOutputValue>, undefined, unknown> {
        const outputs = Reflect.apply(iterate, statement, parameters) as ReturnType<
          StatementSync['iterate']
        >;
        for (const row of outputs) {
          transferredRows += 1;
          yield row;
        }
        return;
      });
    }
    return statement;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  sandbox?.close();
  writer?.close();
  rmSync(directory, { force: true, recursive: true });
});

function insert(
  content: string,
  id = 'chunk',
  fileId = 'selected',
  rootId: string | null = 'authorized'
): void {
  writer
    .prepare('INSERT INTO file_chunks VALUES(?,?,?,?,?,1,3,0,384,?,0,?,4)')
    .run(id, rootId, fileId, content, 'hash', 'text', content.length);
}

function canonical(options: SqliteGrepOptions): ReturnType<SqliteSandbox['grep']> {
  return sandbox.grep({
    ...options,
    isRegex: true,
    pattern: options.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  });
}

it('removes nonmatching rows before real SQLite transfers them while retaining snapshot metadata', () => {
  for (let index = 0; index < 32; index += 1) {
    insert(`ordinary content ${index}`, `chunk-${index}`);
  }
  const result = sandbox.grep(defaults);
  expect(result.rows).toEqual([]);
  expect(result.matchedChunks).toBe(0);
  expect(result.truncated).toBe(false);
  expect(result.identity.storeId).toBe('a'.repeat(64));
  expect(transferredRows).toBe(1);
});

it('keeps a valid 18-million-byte Unicode literal on the canonical scan path', () => {
  insert('ordinary', 'a');
  insert('also ordinary', 'b');
  const pattern = '漢'.repeat(6_000_000);
  expect(Buffer.byteLength(pattern)).toBe(18_000_000);
  const options = { ...defaults, pattern };
  // Han has no case mapping, so the unfiltered literal path is an exact comparator.
  const expected = sandbox.grep({ ...options, caseSensitive: false });
  expect(expected.rows).toEqual([]);
  expect(expected.matchedChunks).toBe(0);
  transferredRows = 0;
  expect(sandbox.grep(options)).toEqual(expected);
  expect(transferredRows).toBe(2);
});

it('keeps a Unicode literal at the configured 16 MiB byte boundary eligible', () => {
  insert('ordinary', 'a');
  insert('also ordinary', 'b');
  const byteLimit = 16 * 1024 * 1024;
  const pattern = '漢'.repeat(Math.floor(byteLimit / 3)) + 'x'.repeat(byteLimit % 3);
  expect(Buffer.byteLength(pattern)).toBe(byteLimit);
  const options = { ...defaults, pattern };
  const expected = sandbox.grep({ ...options, caseSensitive: false });
  transferredRows = 0;
  expect(sandbox.grep(options)).toEqual(expected);
  expect(transferredRows).toBe(1);
});

it.each([
  'needle',
  'é漢',
  '😀🛰',
  'e\u0301',
  '\u0000x',
  "'_%?",
  'line\nnext',
  '😀',
  '\ud83d\ude00x',
  '\ud83d\ude00\ud83d',
  '\ude00x',
  '�b',
])('agrees with the canonical line matcher for literal %j', (pattern) => {
  insert(`before ${pattern} after`, 'match');
  insert('', 'empty');
  insert('ordinary 😀x �b\nafter', 'ordinary');
  insert(`unauthorized ${pattern}`, 'hidden', 'other', 'unauthorized');
  const options = { ...defaults, pattern };
  expect(sandbox.grep(options)).toEqual(canonical(options));
});

it('does not hide replacement-character matches from invalid UTF-8 TEXT', () => {
  writer.exec(
    "INSERT INTO file_chunks VALUES('invalid','authorized','selected',CAST(X'61FF62' AS TEXT),'hash',1,1,0,384,'text',0,3,1)"
  );
  const options = { ...defaults, pattern: '�b' };
  const result = sandbox.grep(options);
  expect(result).toEqual(canonical(options));
  expect(result.rows.map((row) => row[0])).toEqual(['invalid']);
});

it('prefilters case-insensitive literals while preserving regex scans', () => {
  insert('NEEDLE', 'upper');
  insert('needle', 'lower');
  insert('ordinary', 'ordinary');
  expect(sandbox.grep({ ...defaults, caseSensitive: false }).matchedChunks).toBe(2);
  expect(transferredRows).toBe(2);
  transferredRows = 0;
  expect(sandbox.grep({ ...defaults, isRegex: true, pattern: '^NEED' }).matchedChunks).toBe(1);
  expect(transferredRows).toBe(3);
});

it('preserves exhaustive count, ordered capped rows, chunk metadata and root authorization', () => {
  insert('needle three', 'c');
  insert('needle one', 'a');
  insert('ordinary', 'b');
  insert('needle two', 'd');
  insert('needle hidden', 'hidden', 'other', 'unauthorized');
  const options = { ...defaults, maxRows: 2 };
  const result = sandbox.grep(options);
  expect(result).toEqual(canonical(options));
  expect(result.rows.map((row) => row[0])).toEqual(['a', 'c']);
  expect(result.rows[0]?.slice(5)).toEqual(['hash', 1, 3, 0, 384, 'text', 0, 10, 4]);
  expect(result.matchedChunks).toBe(3);
  expect(result.truncated).toBe(true);
});

it('preserves nullable collection identity and empty main-authorized inventories', () => {
  insert('needle retained', 'retained-chunk', 'retained', null);
  insert('needle hidden', 'hidden', 'other', 'unauthorized');
  const options = { ...defaults, fileIds: ['retained'], rootIds: [] };
  const result = sandbox.grep(options);
  expect(result).toEqual(canonical(options));
  expect(result.rows[0]?.slice(0, 4)).toEqual(['retained-chunk', null, 'retained', null]);
  expect(result.rows[0]?.slice(14)).toEqual(['collection', null]);
  expect(sandbox.grep({ ...options, fileIds: [] })).toEqual(canonical({ ...options, fileIds: [] }));
  expect(sandbox.grep({ ...options, fileIds: [] }).rows).toEqual([]);
});

it.each([null, 42, Buffer.from('ordinary')])(
  'retains fatal non-text content %j on nonmatching rows',
  (content) => {
    insert('ordinary');
    writer.prepare('UPDATE file_chunks SET content=?').run(content);
    expect(() => canonical(defaults)).toThrow('Native grep chunk content must be text.');
    expect(() => sandbox.grep(defaults)).toThrow('Native grep chunk content must be text.');
  }
);

it.each([
  ['file_chunks', 'id'],
  ['file_chunks', 'content_hash'],
  ['file_chunks', 'start_line'],
  ['file_chunks', 'end_line'],
  ['file_chunks', 'chunk_index'],
  ['file_chunks', 'chunk_size'],
  ['file_chunks', 'chunk_type'],
  ['file_chunks', 'start_offset'],
  ['file_chunks', 'end_offset'],
  ['file_chunks', 'token_count'],
  ['file_records', 'path'],
  ['file_records', 'embedding_set_id'],
  ['file_records', 'source_path'],
])('retains fatal non-finite REAL values in %s.%s on nonmatching rows', (table, column) => {
  insert('ordinary');
  writer.prepare(`UPDATE ${table} SET ${column}=?`).run(Number.POSITIVE_INFINITY);
  const options = { ...defaults, fileIds: ['selected'] };
  expect(() => canonical(options)).toThrow();
  expect(() => sandbox.grep(options)).toThrow();
});

it('retains fatal non-finite nullable roots selected by canonical file IDs', () => {
  insert('ordinary');
  writer.prepare('UPDATE file_chunks SET root_id=?').run(Number.NEGATIVE_INFINITY);
  writer
    .prepare('UPDATE file_records SET root_id=? WHERE id=?')
    .run(Number.NEGATIVE_INFINITY, 'selected');
  const options = { ...defaults, fileIds: ['selected'] };
  expect(() => canonical(options)).toThrow();
  expect(() => sandbox.grep(options)).toThrow();
});

it('retains fatal non-finite file record IDs in the root-authorized join', () => {
  insert('ordinary');
  writer.prepare('UPDATE file_chunks SET file_record_id=?').run(Number.POSITIVE_INFINITY);
  writer
    .prepare('UPDATE file_records SET id=? WHERE id=?')
    .run(Number.POSITIVE_INFINITY, 'selected');
  expect(() => canonical(defaults)).toThrow();
  expect(() => sandbox.grep(defaults)).toThrow();
});

it.each([9_223_372_036_854_775_807n, -9_223_372_036_854_775_808n])(
  'retains native integer conversion errors for %s on nonmatching rows',
  (value) => {
    insert('ordinary');
    writer.prepare('UPDATE file_chunks SET token_count=?').run(value);
    expect(() => canonical(defaults)).toThrow('too large');
    expect(() => sandbox.grep(defaults)).toThrow('too large');
  }
);

it('does not retain valid finite numbers solely for their numeric storage type', () => {
  insert('ordinary');
  writer.prepare('UPDATE file_chunks SET token_count=?').run(Number.MAX_VALUE);
  expect(sandbox.grep(defaults).rows).toEqual([]);
  expect(transferredRows).toBe(1);
});

it('preserves matches after malformed UTF-8 prefixes for well-formed Unicode literals', () => {
  for (const pattern of ['ab', 'é漢', '😀x', '\u0000x']) {
    writer.exec('DELETE FROM file_chunks');
    const insertBytes = writer.prepare(
      "INSERT INTO file_chunks VALUES(?,'authorized','selected',CAST(? AS TEXT),'hash',1,1,0,384,'text',0,3,1)"
    );
    for (let byte = 0; byte < 256; byte += 1) {
      insertBytes.run(`byte-${byte}`, Buffer.concat([Buffer.from([byte]), Buffer.from(pattern)]));
    }
    const options = { ...defaults, maxRows: 200, pattern };
    const result = sandbox.grep(options);
    expect(result).toEqual(canonical(options));
    expect(result.matchedChunks).toBe(256);
  }
});

it('retains fatal metadata errors even when all content is nonmatching', () => {
  insert('ordinary');
  writer.exec('UPDATE index_metadata SET schema_version=999');
  expect(() => canonical(defaults)).toThrow();
  expect(() => sandbox.grep(defaults)).toThrow();
});

it('does not hide corruption after the requested result cap', () => {
  insert('needle', 'a');
  insert('ordinary', 'z');
  writer
    .prepare('UPDATE file_chunks SET token_count=? WHERE id=?')
    .run(Number.POSITIVE_INFINITY, 'z');
  const options = { ...defaults, maxRows: 1 };
  expect(() => canonical(options)).toThrow();
  expect(() => sandbox.grep(options)).toThrow();
});

it.each(['text', 'blob', 'combined blobs'])(
  'avoids materializing nonmatching oversized values while preserving engine limits (%s)',
  (kind) => {
    insert('ordinary');
    if (kind === 'combined blobs') {
      const bytes = Buffer.alloc(9 * 1024 * 1024, 120);
      writer.prepare('UPDATE file_chunks SET content_hash=?,chunk_type=?').run(bytes, bytes);
    } else {
      const content = 'x'.repeat(17 * 1024 * 1024);
      writer
        .prepare('UPDATE file_chunks SET content_hash=?')
        .run(kind === 'text' ? content : Buffer.from(content));
    }
    expect(() => canonical(defaults)).toThrow();
    const result = sandbox.grep(defaults);
    expect(result.rows).toEqual([]);
    expect(result.matchedChunks).toBe(0);
    // The same configured sandbox still rejects a matching oversized row.
    writer.exec("UPDATE file_chunks SET content='needle'");
    expect(() => sandbox.grep(defaults)).toThrow();
  }
);

it('retains the result budget and rejects empty patterns', () => {
  insert(`needle ${'x'.repeat(1024 * 1024)}`);
  expect(() => sandbox.grep(defaults)).toThrow('1 MiB');
  expect(() => sandbox.grep({ ...defaults, pattern: '' })).toThrow();
});

it.each([
  ['needle', ['ascii']],
  ['ke', ['unicode']],
  ['ai', ['unicode']],
  ['KE', ['unicode']],
  ['\u212Ae', ['unicode']],
  ['workspace indexing startup', ['ascii']],
])('keeps case-insensitive Unicode matching sound for %j', (pattern, expected) => {
  insert('NEEDLE workspace INDEXING startup', 'ascii');
  insert('\u212Aelvin a\u0130 dot', 'unicode');
  insert('ordinary', 'ordinary');
  const result = sandbox.grep({ ...defaults, caseSensitive: false, pattern });
  expect(result.rows.map((row) => row[0])).toEqual(expected);
  expect(result.matchedChunks).toBe(expected.length);
});

it('filters a case-insensitive nonmatch before transferring real native rows', () => {
  for (let index = 0; index < 32; index += 1) {
    insert(`ordinary content ${index}`, `chunk-${index}`);
  }
  expect(sandbox.grep({ ...defaults, caseSensitive: false }).matchedChunks).toBe(0);
  expect(transferredRows).toBe(1);
});

it('preserves case-insensitive exhaustive counts, nullable collection identity and ordered caps', () => {
  insert('NEEDLE one', 'a', 'retained', null);
  insert('needle two', 'b', 'retained', null);
  insert('NEEDLE hidden', 'hidden', 'other', 'unauthorized');
  const result = sandbox.grep({
    ...defaults,
    caseSensitive: false,
    fileIds: ['retained'],
    maxRows: 1,
    rootIds: [],
  });
  expect(result.matchedChunks).toBe(2);
  expect(result.truncated).toBe(true);
  expect(result.rows.map((row) => row[0])).toEqual(['a']);
  expect(result.rows[0]?.slice(1, 4)).toEqual([null, 'retained', null]);
});

it('retains non-ASCII needles and embedded NUL content for canonical case conversion', () => {
  insert('ÉLAN ordinary', 'unicode');
  insert('before\u0000NEEDLE after', 'nul');
  expect(
    sandbox.grep({ ...defaults, caseSensitive: false, pattern: 'élan' }).rows.map((row) => row[0])
  ).toEqual(['unicode']);
  expect(sandbox.grep({ ...defaults, caseSensitive: false }).rows.map((row) => row[0])).toEqual([
    'nul',
  ]);
});

it('retains case-insensitive nonmatching row conversion failures', () => {
  insert('ordinary');
  writer.prepare('UPDATE file_chunks SET end_line=?').run(Number.POSITIVE_INFINITY);
  expect(() => sandbox.grep({ ...defaults, caseSensitive: false })).toThrow();
});
