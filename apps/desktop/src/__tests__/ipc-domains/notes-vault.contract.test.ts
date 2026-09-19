import { NOTES_VAULT_BRIDGE_REQUIRED_METHODS } from '@brainstrike/notes-vault/desktop-contract';
import { describe, expect, it } from 'vitest';
import { notesVaultContract } from '../../ipc-domains/notes-vault.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

describe('notes vault IPC contract', () => {
  it('derives the exact renderer bridge key set', () => {
    expect(Object.keys(notesVaultContract).sort()).toEqual(
      [...NOTES_VAULT_BRIDGE_REQUIRED_METHODS].sort()
    );
  });

  it('keeps established result envelopes raw and invokes visible-UI-only', () => {
    for (const spec of Object.values(notesVaultContract)) {
      if (spec.kind === 'push') {
        continue;
      }
      expect(spec).toMatchObject({ envelope: 'raw', roles: ['visible-ui'] });
    }
  });

  it('classifies the changed notification as the sole main-to-renderer push', () => {
    expect(notesVaultContract.onChanged).toEqual({
      channel: DESKTOP_IPC_CHANNELS.notesVault.changed,
      kind: 'push',
    });
    expect(Object.values(notesVaultContract).filter((spec) => spec.kind === 'push')).toHaveLength(
      1
    );
  });

  it('maps every invoke to its manifest channel', () => {
    const { changed: _changed, ...invokeChannels } = DESKTOP_IPC_CHANNELS.notesVault;
    const contractChannels = Object.fromEntries(
      Object.entries(notesVaultContract)
        .filter(([, spec]) => spec.kind === 'invoke')
        .map(([key, spec]) => [key, spec.channel])
    );
    expect(contractChannels).toEqual(invokeChannels);
  });

  it('parses every invoke into its handler tuple', () => {
    expect(notesVaultContract.ensureDefaultVault.parseArgs([])).toEqual([]);
    expect(notesVaultContract.pickDirectory.parseArgs([])).toEqual([]);
    for (const operation of [
      'createDirectory',
      'listDirectory',
      'readFile',
      'registerRoot',
      'statEntry',
      'watch',
      'unwatch',
    ] as const) {
      expect(notesVaultContract[operation].parseArgs(['/vault'])).toEqual(['/vault']);
    }
    expect(
      notesVaultContract.deleteEntry.parseArgs(['/vault/note.md', { recursive: false }])
    ).toEqual(['/vault/note.md', { recursive: false }]);
    expect(notesVaultContract.rename.parseArgs(['/vault/a.md', '/vault/b.md'])).toEqual([
      '/vault/a.md',
      '/vault/b.md',
    ]);
    expect(notesVaultContract.writeFile.parseArgs(['/vault/note.md', '# Note'])).toEqual([
      '/vault/note.md',
      '# Note',
    ]);
  });

  it('rejects malformed direct IPC input before handler entry', () => {
    expect(() => notesVaultContract.ensureDefaultVault.parseArgs(['unexpected'])).toThrow(
      'notes vault ensureDefaultVault requires exactly 0 arguments'
    );
    expect(() => notesVaultContract.readFile.parseArgs([42])).toThrow(
      'notes vault readFile path must be a string'
    );
    expect(() => notesVaultContract.rename.parseArgs(['/vault/a.md'])).toThrow(
      'notes vault rename requires exactly 2 arguments'
    );
    expect(() => notesVaultContract.writeFile.parseArgs(['/vault/a.md', 42])).toThrow(
      'notes vault writeFile second argument must be a string'
    );
    expect(() => notesVaultContract.deleteEntry.parseArgs(['/vault/a.md', null])).toThrow(
      'notes vault deleteEntry options requires an object'
    );
    expect(() =>
      notesVaultContract.deleteEntry.parseArgs(['/vault/a.md', { recursive: false, token: 'x' }])
    ).toThrow('notes vault deleteEntry options received unsupported fields: token');
    expect(() =>
      notesVaultContract.deleteEntry.parseArgs(['/vault/a.md', { recursive: 'yes' }])
    ).toThrow('notes vault deleteEntry recursive must be a boolean');
  });

  it('leaves type-valid path policy failures for raw-result handlers', () => {
    expect(notesVaultContract.readFile.parseArgs([''])).toEqual(['']);
    expect(notesVaultContract.rename.parseArgs(['relative.md', 'renamed.md'])).toEqual([
      'relative.md',
      'renamed.md',
    ]);
  });
});
