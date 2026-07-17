import { describe, expect, it } from 'vitest';
import { FakeDirectoryHandle, fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import { createVaultFolder, deleteVaultEntry, renameVaultEntry } from '../entry-ops';

describe('createVaultFolder', () => {
  it('creates a folder under the parent', async () => {
    const parent = fakeDir('vault');

    await createVaultFolder(parent, 'projects');

    expect(parent.entries.get('projects')).toBeInstanceOf(FakeDirectoryHandle);
  });

  it('rejects collisions and invalid names with clear errors', async () => {
    const parent = fakeDir('vault', [fakeDir('existing'), fakeNote('note.md')]);

    await expect(createVaultFolder(parent, 'existing')).rejects.toThrow(/already exists/i);
    await expect(createVaultFolder(parent, 'note.md')).rejects.toThrow(/already exists/i);
    await expect(createVaultFolder(parent, '')).rejects.toThrow(/name/i);
    await expect(createVaultFolder(parent, 'a/b')).rejects.toThrow(/name/i);
    await expect(createVaultFolder(parent, '..')).rejects.toThrow(/name/i);
    await expect(createVaultFolder(parent, '.hidden')).rejects.toThrow(/name/i);
  });
});

describe('deleteVaultEntry', () => {
  it('deletes a note', async () => {
    const parent = fakeDir('vault', [fakeNote('a.md')]);

    await deleteVaultEntry(parent, 'a.md', 'note');

    expect(parent.entries.has('a.md')).toBe(false);
  });

  it('deletes a folder recursively', async () => {
    const parent = fakeDir('vault', [fakeDir('sub', [fakeNote('deep.md')])]);

    await deleteVaultEntry(parent, 'sub', 'folder');

    expect(parent.entries.has('sub')).toBe(false);
  });

  it('throws explicitly when the backend cannot delete (no silent fallback)', async () => {
    const parent = fakeDir('vault', [fakeNote('a.md')]);
    (parent as { removeEntry?: unknown }).removeEntry = undefined;

    await expect(deleteVaultEntry(parent, 'a.md', 'note')).rejects.toThrow(/does not support/i);
  });
});

describe('renameVaultEntry', () => {
  it('renames a note via the handle move capability', async () => {
    const parent = fakeDir('vault', [fakeNote('old.md', { content: 'body' })]);
    const note = await parent.getFileHandle('old.md');

    await renameVaultEntry(parent, note, 'new name.md');

    expect(parent.entries.has('old.md')).toBe(false);
    expect(parent.entries.get('new name.md')).toBeDefined();
  });

  it('rejects collisions and invalid names', async () => {
    const parent = fakeDir('vault', [fakeNote('a.md'), fakeNote('b.md')]);
    const note = await parent.getFileHandle('a.md');

    await expect(renameVaultEntry(parent, note, 'b.md')).rejects.toThrow(/already exists/i);
    await expect(renameVaultEntry(parent, note, 'x/y.md')).rejects.toThrow(/name/i);
  });

  it('allows a case-only rename even when the backend resolves names case-insensitively', async () => {
    // Mimic a case-insensitive/case-preserving filesystem (default macOS):
    // probing the new casing resolves to the SAME entry, which must not be
    // treated as a collision — otherwise casing fixes are impossible.
    const parent = fakeDir('vault', [fakeNote('Note.md', { content: 'body' })]);
    const caseSensitiveGetFileHandle = parent.getFileHandle.bind(parent);
    parent.getFileHandle = (name: string, options?: { create?: boolean }) => {
      const match = [...parent.entries.keys()].find(
        (existing) => existing.toLowerCase() === name.toLowerCase()
      );
      return caseSensitiveGetFileHandle(match ?? name, options);
    };
    const note = await parent.getFileHandle('Note.md');

    await renameVaultEntry(parent, note, 'note.md');

    expect(parent.entries.has('Note.md')).toBe(false);
    expect(parent.entries.get('note.md')).toBeDefined();
  });

  it('throws explicitly when the backend cannot rename this entry', async () => {
    const parent = fakeDir('vault', [fakeDir('sub')]);
    const folder = await parent.getDirectoryHandle('sub');
    (folder as { move?: unknown }).move = undefined;

    await expect(renameVaultEntry(parent, folder, 'renamed')).rejects.toThrow(/does not support/i);
  });
});
