import { describe, expect, it } from 'vitest';
import {
  decodeFileMentionId,
  encodeFileMentionId,
  FILE_MENTION_DIRECTIVE_TYPE,
  parseFileMentionDirectives,
  serializeFileMentionDirective,
  splitFileMentionSegments,
} from '../file-mention-directive.js';

describe('encodeFileMentionId / decodeFileMentionId', () => {
  it('round-trips a (rootId, path) pair through the `rootId::path` id', () => {
    const id = encodeFileMentionId('root-123', 'src/app.ts');
    expect(id).toBe('root-123::src/app.ts');
    expect(decodeFileMentionId(id)).toEqual({ path: 'src/app.ts', rootId: 'root-123' });
  });

  it('preserves a path that itself contains a single colon', () => {
    const id = encodeFileMentionId('root-1', 'a/b:c.ts');
    // Split on the FIRST `::` only, so a lone `:` inside the path survives.
    expect(decodeFileMentionId(id)).toEqual({ path: 'a/b:c.ts', rootId: 'root-1' });
  });

  it('preserves a path that contains `::` after the first separator', () => {
    const id = encodeFileMentionId('root-1', 'a::b.ts');
    expect(decodeFileMentionId(id)).toEqual({ path: 'a::b.ts', rootId: 'root-1' });
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
    // at parse time; the marker gates decoding while encoding keeps the id brace-free.
    expect(encodeFileMentionId('root-1', 'src/a}b.ts')).toBe(
      'root-1::/.brainstrike-file-path-v1/src/a%7Db.ts'
    );
  });

  it('percent-encodes `{` and `%` in the path (id has no raw brace, `%` unambiguous)', () => {
    expect(encodeFileMentionId('root-1', 'src/a{b}c.ts')).toBe(
      'root-1::/.brainstrike-file-path-v1/src/a%7Bb%7Dc.ts'
    );
    expect(encodeFileMentionId('root-1', 'a%b.ts')).toBe(
      'root-1::/.brainstrike-file-path-v1/a%25b.ts'
    );
  });

  it('round-trips a path containing `{`, `}`, and `%` exactly', () => {
    const path = 'dir/a{b}c%d.ts';
    const id = encodeFileMentionId('root-1', path);
    expect(id).not.toContain('{');
    expect(id.slice('root-1::'.length)).not.toContain('}');
    expect(decodeFileMentionId(id)).toEqual({ path, rootId: 'root-1' });
  });

  it('does not mis-decode a path that literally contains `%7D` (the encoded form of `}`)', () => {
    const path = 'a%7Db.ts';
    const id = encodeFileMentionId('root-1', path);
    // Literal `%` is escaped to `%25` first, so decode reverses to the literal text.
    expect(id).toBe('root-1::/.brainstrike-file-path-v1/a%257Db.ts');
    expect(decodeFileMentionId(id)).toEqual({ path, rootId: 'root-1' });
  });

  it('preserves legacy unmarked percent sequences as raw path text', () => {
    const legacyDirective = ':file[a%7Db.ts]{name=root-1::src/a%7Db.ts}';

    expect(parseFileMentionDirectives(legacyDirective)).toEqual([
      { id: 'root-1::src/a%7Db.ts', label: 'a%7Db.ts', path: 'src/a%7Db.ts', rootId: 'root-1' },
    ]);
  });

  it('decodes pre-marker encoded ids when the label proves the basename', () => {
    const preMarkerBraceDirective = ':file[a}b.ts]{name=root-1::src/a%7Db.ts}';
    const preMarkerPercentDirective = ':file[a%b.ts]{name=root-1::src/a%25b.ts}';

    expect(
      parseFileMentionDirectives(`${preMarkerBraceDirective} ${preMarkerPercentDirective}`)
    ).toEqual([
      { id: 'root-1::src/a%7Db.ts', label: 'a}b.ts', path: 'src/a}b.ts', rootId: 'root-1' },
      { id: 'root-1::src/a%25b.ts', label: 'a%b.ts', path: 'src/a%b.ts', rootId: 'root-1' },
    ]);
  });

  it('preserves ambiguous pre-marker directory escapes as raw path text', () => {
    const ambiguousDirective = ':file[b.ts]{name=root-1::src/a%7Ddir/b.ts}';

    expect(parseFileMentionDirectives(ambiguousDirective)).toEqual([
      {
        id: 'root-1::src/a%7Ddir/b.ts',
        label: 'b.ts',
        path: 'src/a%7Ddir/b.ts',
        rootId: 'root-1',
      },
    ]);
  });

  it('preserves `::` in a path alongside an encoded brace', () => {
    const path = 'a}::b.ts';
    const id = encodeFileMentionId('root-1', path);
    expect(decodeFileMentionId(id)).toEqual({ path, rootId: 'root-1' });
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
      id: 'root-1::src/app.ts',
      label: 'app.ts',
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
      { id: 'root-1::src/app.ts', label: 'app.ts', path: 'src/app.ts', rootId: 'root-1' },
    ]);
  });

  it('extracts multiple distinct directives in document order', () => {
    const text = 'Compare :file[a.ts]{name=r1::a.ts} and :file[b.ts]{name=r2::pkg/b.ts} carefully.';
    expect(parseFileMentionDirectives(text)).toEqual([
      { id: 'r1::a.ts', label: 'a.ts', path: 'a.ts', rootId: 'r1' },
      { id: 'r2::pkg/b.ts', label: 'b.ts', path: 'pkg/b.ts', rootId: 'r2' },
    ]);
  });

  it('dedupes repeated references to the same id (first occurrence wins)', () => {
    const text = ':file[a.ts]{name=r1::a.ts} ... :file[a.ts]{name=r1::a.ts}';
    expect(parseFileMentionDirectives(text)).toEqual([
      { id: 'r1::a.ts', label: 'a.ts', path: 'a.ts', rootId: 'r1' },
    ]);
  });

  it('ignores non-file directives (e.g. a slash/command directive type)', () => {
    const text = 'A :command[thing]{name=x} and a :file[a.ts]{name=r1::a.ts}.';
    expect(parseFileMentionDirectives(text)).toEqual([
      { id: 'r1::a.ts', label: 'a.ts', path: 'a.ts', rootId: 'r1' },
    ]);
  });

  it('skips a malformed file directive whose id is not a valid `rootId::path`', () => {
    const text = ':file[a.ts]{name=missing-separator} :file[b.ts]{name=r1::b.ts}';
    expect(parseFileMentionDirectives(text)).toEqual([
      { id: 'r1::b.ts', label: 'b.ts', path: 'b.ts', rootId: 'r1' },
    ]);
  });

  it('returns an empty array for plain text with no directives', () => {
    expect(parseFileMentionDirectives('just a normal message')).toEqual([]);
  });

  it('round-trips serialize -> parse', () => {
    const directive = serializeFileMentionDirective({ id: 'r::dir/x.ts', label: 'x.ts' });
    expect(parseFileMentionDirectives(`see ${directive}`)).toEqual([
      { id: 'r::dir/x.ts', label: 'x.ts', path: 'dir/x.ts', rootId: 'r' },
    ]);
  });

  it('round-trips serialize -> parse for a path containing `}` (no id truncation)', () => {
    // The real bug: a raw `}` in the id ends `{name=…}` early, truncating the path.
    const path = 'dir/a}b.ts';
    const directive = serializeFileMentionDirective({
      id: encodeFileMentionId('root-1', path),
      label: 'a}b.ts',
    });
    expect(parseFileMentionDirectives(`open ${directive} now`)).toEqual([
      {
        id: 'root-1::/.brainstrike-file-path-v1/dir/a%7Db.ts',
        label: 'a}b.ts',
        path,
        rootId: 'root-1',
      },
    ]);
  });
});

describe('splitFileMentionSegments (BST-2043)', () => {
  const directive = serializeFileMentionDirective({
    id: encodeFileMentionId('20e9b88e-5b1f-413e-94ad-5f680aeab4c2', 'docs/context.txt'),
    label: 'context.txt',
  });

  it('splits literal text and every file mention in order, losing nothing', () => {
    const text = `Read ${directive}\n\nthen ${directive} again`;
    const segments = splitFileMentionSegments(text);
    expect(segments).toEqual([
      { kind: 'text', text: 'Read ' },
      {
        id: '20e9b88e-5b1f-413e-94ad-5f680aeab4c2::docs/context.txt',
        kind: 'file',
        label: 'context.txt',
        path: 'docs/context.txt',
        raw: directive,
        rootId: '20e9b88e-5b1f-413e-94ad-5f680aeab4c2',
      },
      { kind: 'text', text: '\n\nthen ' },
      expect.objectContaining({ kind: 'file', label: 'context.txt' }),
      { kind: 'text', text: ' again' },
    ]);
    expect(
      segments.map((segment) => (segment.kind === 'text' ? segment.text : segment.raw)).join('')
    ).toBe(text);
  });

  it('keeps other directive types and undecodable file ids as literal text', () => {
    const text = 'Use :cmd[review] and :file[x.ts]{name=no-separator} as typed';
    expect(splitFileMentionSegments(text)).toEqual([{ kind: 'text', text }]);
  });

  it('returns no segments for empty text and one literal run without directives', () => {
    expect(splitFileMentionSegments('')).toEqual([]);
    expect(splitFileMentionSegments('plain **text**')).toEqual([
      { kind: 'text', text: 'plain **text**' },
    ]);
  });
});
