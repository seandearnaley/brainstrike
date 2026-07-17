import { describe, expect, it } from 'vitest';
import { fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import { scanVaultDirectory } from '../scan';
import { sortVaultTree } from '../sort';
import type { VaultTreeNode } from '../types';

const ROOT_ID = 'root-1';

function names(nodes: readonly VaultTreeNode[]): string[] {
  return nodes.map((node) => node.name);
}

async function scanNodes(root: ReturnType<typeof fakeDir>): Promise<VaultTreeNode[]> {
  const { nodes } = await scanVaultDirectory(root, ROOT_ID);
  return nodes;
}

describe('sortVaultTree', () => {
  it('always groups folders before notes', async () => {
    const nodes = await scanNodes(
      fakeDir('vault', [fakeNote('aaa.md'), fakeDir('zzz'), fakeNote('bbb.md'), fakeDir('mmm')])
    );

    for (const mode of ['name-asc', 'name-desc', 'modified-desc', 'modified-asc'] as const) {
      const sorted = sortVaultTree(nodes, mode);
      const kinds = sorted.map((node) => node.type);
      expect(kinds, mode).toEqual(['folder', 'folder', 'note', 'note']);
    }
  });

  it('sorts names with numeric-aware, case-insensitive collation', async () => {
    const nodes = await scanNodes(
      fakeDir('vault', [fakeNote('note10.md'), fakeNote('Note2.md'), fakeNote('apple.md')])
    );

    expect(names(sortVaultTree(nodes, 'name-asc'))).toEqual(['apple.md', 'Note2.md', 'note10.md']);
    expect(names(sortVaultTree(nodes, 'name-desc'))).toEqual(['note10.md', 'Note2.md', 'apple.md']);
  });

  it('sorts by lastModified, folders using their aggregated descendant time', async () => {
    const nodes = await scanNodes(
      fakeDir('vault', [
        fakeNote('old.md', { lastModified: 100 }),
        fakeNote('new.md', { lastModified: 900 }),
        fakeDir('quiet', [fakeNote('a.md', { lastModified: 50 })]),
        fakeDir('busy', [fakeNote('b.md', { lastModified: 500 })]),
      ])
    );

    expect(names(sortVaultTree(nodes, 'modified-desc'))).toEqual([
      'busy',
      'quiet',
      'new.md',
      'old.md',
    ]);
    expect(names(sortVaultTree(nodes, 'modified-asc'))).toEqual([
      'quiet',
      'busy',
      'old.md',
      'new.md',
    ]);
  });

  it('sorts recursively without mutating the input tree', async () => {
    const nodes = await scanNodes(
      fakeDir('vault', [fakeDir('folder', [fakeNote('b.md'), fakeNote('a.md')])])
    );
    const originalChildNames = names(nodes[0]?.type === 'folder' ? nodes[0].children : []);

    const sorted = sortVaultTree(nodes, 'name-asc');

    const sortedFolder = sorted[0];
    expect(sortedFolder?.type).toBe('folder');
    if (sortedFolder?.type === 'folder') {
      expect(names(sortedFolder.children)).toEqual(['a.md', 'b.md']);
    }
    const inputFolder = nodes[0];
    if (inputFolder?.type === 'folder') {
      expect(names(inputFolder.children)).toEqual(originalChildNames);
    }
  });

  it('breaks lastModified ties by name ascending', async () => {
    const nodes = await scanNodes(
      fakeDir('vault', [
        fakeNote('zeta.md', { lastModified: 100 }),
        fakeNote('alpha.md', { lastModified: 100 }),
      ])
    );

    expect(names(sortVaultTree(nodes, 'modified-desc'))).toEqual(['alpha.md', 'zeta.md']);
  });
});
