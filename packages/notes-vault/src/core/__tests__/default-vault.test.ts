import { describe, expect, it } from 'vitest';
import { FakeFileHandle, fakeDir } from '../../__tests__/support/fake-handles';
import { DEFAULT_VAULT_DIR_NAME, ensureDefaultVault } from '../default-vault';

describe('ensureDefaultVault', () => {
  it('creates the vault directory on first run and seeds a welcome note', async () => {
    const opfsRoot = fakeDir('opfs-root');

    const vault = await ensureDefaultVault(opfsRoot);

    expect(vault.name).toBe(DEFAULT_VAULT_DIR_NAME);
    const welcome = (await opfsRoot.getDirectoryHandle(DEFAULT_VAULT_DIR_NAME)) as ReturnType<
      typeof fakeDir
    >;
    const note = welcome.entries.get('Welcome.md');
    expect(note).toBeInstanceOf(FakeFileHandle);
    expect((note as FakeFileHandle).state.content).toMatch(/# Welcome/);
  });

  it('does not reseed the welcome note once the vault exists (deletions stick)', async () => {
    const opfsRoot = fakeDir('opfs-root');
    await ensureDefaultVault(opfsRoot);
    const vault = (await opfsRoot.getDirectoryHandle(DEFAULT_VAULT_DIR_NAME)) as ReturnType<
      typeof fakeDir
    >;
    vault.entries.delete('Welcome.md');

    await ensureDefaultVault(opfsRoot);

    expect(vault.entries.has('Welcome.md')).toBe(false);
  });
});
