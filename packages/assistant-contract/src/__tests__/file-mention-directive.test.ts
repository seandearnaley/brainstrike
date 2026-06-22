import { describe, expect, it } from 'vitest';
import {
  decodeFileMentionId,
  encodeFileMentionId,
  FILE_MENTION_DIRECTIVE_TYPE,
  parseFileMentionDirectives,
  serializeFileMentionDirective,
} from '../file-mention-directive.js';

describe('encodeFileMentionId / decodeFileMentionId', () => {
  it('round-trips a (rootId, path) pair through the `rootId::path` id', () => {
    const id = encodeFileMentionId('root-123', 'src/app.ts');
    expect(id).toBe('root-123::src/app.ts');
    expect(decodeFileMentionId(id)).toEqual({ rootId: 'root-123', path: 'src/app.ts' });
  });

  it('preserves a path that itself contains a single colon', () => {
    const id = encodeFileMentionId('root-1', 'a/b:c.ts');
    // Split on the FIRST `::` only, so a lone `:` inside the path survives.
    expect(decodeFileMentionId(id)).toEqual({ rootId: 'root-1', path: 'a/b:c.ts' });
  });

  it('preserves a path that contains `::` after the first separator', () => {
    const id = encodeFileMentionId('root-1', 'a::b.ts');
    expect(decodeFileMentionId(id)).toEqual({ rootId: 'root-1', path: 'a::b.ts' });
  });

  it('returns null for an id without the `::` separator', () => {
    expect(decodeFileMentionId('not-a-valid-id')).toBeNull();
  });

  it('returns null for an id with an empty root or empty path', () => {
    expect(decodeFileMentionId('::src/app.ts')).toBeNull();
    expect(decodeFileMentionId('root-1::')).toBeNull();
  });

  it('throws when encoding with an empty rootId or path (no silent fallback)', () => {
    expect(() => encodeFileMentionId('', 'src/app.ts')).toThrow();
    expect(() => encodeFileMentionId('root-1', '')).toThrow();
  });

  it('percent-encodes `}` in the path so it cannot truncate the `{name=…}` id', () => {
    // A literal `}` in the id would end the directive's `{name=…}` attribute early
    // at parse time; encoding it keeps the id brace-free.
    expect(encodeFileMentionId('root-1', 'src/a}b.ts')).toBe('root-1::src/a%7Db.ts');
  });

  it('percent-encodes `{` and `%` in the path (id has no raw brace, `%` unambiguous)', () => {
    expect(encodeFileMentionId('root-1', 'src/a{b}c.ts')).toBe('root-1::src/a%7Bb%7Dc.ts');
    expect(encodeFileMentionId('root-1', 'a%b.ts')).toBe('root-1::a%25b.ts');
  });

  it('round-trips a path containing `{`, `}`, and `%` exactly', () => {
    const path = 'dir/a{b}c%d.ts';
    const id = encodeFileMentionId('root-1', path);
    expect(id).not.toContain('{');
    expect(id.slice('root-1::'.length)).not.toContain('}');
    expect(decodeFileMentionId(id)).toEqual({ rootId: 'root-1', path });
  });

  it('does not mis-decode a path that literally contains `%7D` (the encoded form of `}`)', () => {
    const path = 'a%7Db.ts';
    const id = encodeFileMentionId('root-1', path);
    // Literal `%` is escaped to `%25` first, so decode reverses to the literal text.
    expect(id).toBe('root-1::a%257Db.ts');
    expect(decodeFileMentionId(id)).toEqual({ rootId: 'root-1', path });
  });

  it('preserves `::` in a path alongside an encoded brace', () => {
    const path = 'a}::b.ts';
    const id = encodeFileMentionId('root-1', path);
    expect(decodeFileMentionId(id)).toEqual({ rootId: 'root-1', path });
  });

  it('leaves a path without special characters unchanged (no over-encoding)', () => {
    // encodeURIComponent would mangle `/` and spaces; we touch only `{`/`}`/`%`.
    const path = 'src/some dir/app.ts';
    expect(encodeFileMentionId('root-1', path)).toBe('root-1::src/some dir/app.ts');
  });
});

describe('serializeFileMentionDirective', () => {
  it('serializes to the assistant-ui `:file[label]{name=id}` format', () => {
    const directive = serializeFileMentionDirective({
      label: 'app.ts',
      id: 'root-1::src/app.ts',
    });
    expect(directive).toBe(':file[app.ts]{name=root-1::src/app.ts}');
  });

  it('uses the shared file mention type', () => {
    expect(FILE_MENTION_DIRECTIVE_TYPE).toBe('file');
  });
});

describe('parseFileMentionDirectives', () => {
  it('extracts a single file directive with its decoded root + path', () => {
    const text = 'Please review :file[app.ts]{name=root-1::src/app.ts} for bugs.';
    expect(parseFileMentionDirectives(text)).toEqual([
      { label: 'app.ts', id: 'root-1::src/app.ts', rootId: 'root-1', path: 'src/app.ts' },
    ]);
  });

  it('extracts multiple distinct directives in document order', () => {
    const text = 'Compare :file[a.ts]{name=r1::a.ts} and :file[b.ts]{name=r2::pkg/b.ts} carefully.';
    expect(parseFileMentionDirectives(text)).toEqual([
      { label: 'a.ts', id: 'r1::a.ts', rootId: 'r1', path: 'a.ts' },
      { label: 'b.ts', id: 'r2::pkg/b.ts', rootId: 'r2', path: 'pkg/b.ts' },
    ]);
  });

  it('dedupes repeated references to the same id (first occurrence wins)', () => {
    const text = ':file[a.ts]{name=r1::a.ts} ... :file[a.ts]{name=r1::a.ts}';
    expect(parseFileMentionDirectives(text)).toEqual([
      { label: 'a.ts', id: 'r1::a.ts', rootId: 'r1', path: 'a.ts' },
    ]);
  });

  it('ignores non-file directives (e.g. a slash/command directive type)', () => {
    const text = 'A :command[thing]{name=x} and a :file[a.ts]{name=r1::a.ts}.';
    expect(parseFileMentionDirectives(text)).toEqual([
      { label: 'a.ts', id: 'r1::a.ts', rootId: 'r1', path: 'a.ts' },
    ]);
  });

  it('skips a malformed file directive whose id is not a valid `rootId::path`', () => {
    const text = ':file[a.ts]{name=missing-separator} :file[b.ts]{name=r1::b.ts}';
    expect(parseFileMentionDirectives(text)).toEqual([
      { label: 'b.ts', id: 'r1::b.ts', rootId: 'r1', path: 'b.ts' },
    ]);
  });

  it('returns an empty array for plain text with no directives', () => {
    expect(parseFileMentionDirectives('just a normal message')).toEqual([]);
  });

  it('round-trips serialize -> parse', () => {
    const directive = serializeFileMentionDirective({ label: 'x.ts', id: 'r::dir/x.ts' });
    expect(parseFileMentionDirectives(`see ${directive}`)).toEqual([
      { label: 'x.ts', id: 'r::dir/x.ts', rootId: 'r', path: 'dir/x.ts' },
    ]);
  });

  it('round-trips serialize -> parse for a path containing `}` (no id truncation)', () => {
    // The real bug: a raw `}` in the id ends `{name=…}` early, truncating the path.
    const path = 'dir/a}b.ts';
    const directive = serializeFileMentionDirective({
      label: 'a}b.ts',
      id: encodeFileMentionId('root-1', path),
    });
    expect(parseFileMentionDirectives(`open ${directive} now`)).toEqual([
      { label: 'a}b.ts', id: 'root-1::dir/a%7Db.ts', rootId: 'root-1', path },
    ]);
  });
});
