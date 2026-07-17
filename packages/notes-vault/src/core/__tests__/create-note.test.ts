import { describe, expect, it } from 'vitest';
import { FakeFileHandle, fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import { createVaultNote } from '../create-note';

describe('createVaultNote', () => {
  it('creates an empty titled note with a .md extension', async () => {
    const dir = fakeDir('vault');

    const created = await createVaultNote(dir);

    expect(created.name).toBe('Untitled.md');
    const handle = dir.entries.get('Untitled.md');
    expect(handle).toBeInstanceOf(FakeFileHandle);
    expect((handle as FakeFileHandle).state.content).toBe('# Untitled\n\n');
  });

  it('picks the next free numbered name instead of overwriting', async () => {
    const dir = fakeDir('vault', [fakeNote('Untitled.md'), fakeNote('Untitled 2.md')]);

    const created = await createVaultNote(dir);

    expect(created.name).toBe('Untitled 3.md');
  });

  it('supports a custom title', async () => {
    const dir = fakeDir('vault');

    const created = await createVaultNote(dir, { title: 'Meeting notes' });

    expect(created.name).toBe('Meeting notes.md');
    expect((dir.entries.get('Meeting notes.md') as FakeFileHandle).state.content).toBe(
      '# Meeting notes\n\n'
    );
  });
});
