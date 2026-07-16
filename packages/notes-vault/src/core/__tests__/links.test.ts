import { describe, expect, it } from 'vitest';
import { fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import { findVaultNote, resolveRelativeNoteSegments } from '../links';
import type { VaultRootState } from '../rows';
import { scanVaultDirectory } from '../scan';

describe('resolveRelativeNoteSegments', () => {
  it('resolves sibling and nested relative links against the note location', () => {
    expect(resolveRelativeNoteSegments(['sub', 'note.md'], 'other.md')).toEqual([
      'sub',
      'other.md',
    ]);
    expect(resolveRelativeNoteSegments(['note.md'], './docs/deep.md')).toEqual(['docs', 'deep.md']);
    expect(resolveRelativeNoteSegments(['a', 'b', 'note.md'], '../up.md')).toEqual(['a', 'up.md']);
  });

  it('returns null for links escaping the vault root or non-relative targets', () => {
    expect(resolveRelativeNoteSegments(['note.md'], '../outside.md')).toBeNull();
    expect(resolveRelativeNoteSegments(['note.md'], 'https://example.com/x.md')).toBeNull();
    expect(resolveRelativeNoteSegments(['note.md'], '/absolute.md')).toBeNull();
    expect(resolveRelativeNoteSegments(['note.md'], 'mailto:a@b.c')).toBeNull();
  });

  it('decodes percent-encoded segments', () => {
    expect(resolveRelativeNoteSegments(['note.md'], 'My%20Notes.md')).toEqual(['My Notes.md']);
  });
});

describe('findVaultNote', () => {
  it('finds a nested note by id across roots', async () => {
    const dir = fakeDir('vault', [fakeDir('sub', [fakeNote('deep.md')]), fakeNote('top.md')]);
    const { nodes, noteCount } = await scanVaultDirectory(dir, 'r1');
    const root: VaultRootState = {
      handle: dir,
      name: 'vault',
      nodes,
      noteCount,
      rootId: 'r1',
      status: 'ready',
    };

    expect(findVaultNote([root], 'r1:sub/deep.md')?.name).toBe('deep.md');
    expect(findVaultNote([root], 'r1:top.md')?.name).toBe('top.md');
    expect(findVaultNote([root], 'r1:missing.md')).toBeNull();
  });
});
