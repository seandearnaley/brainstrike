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
});
