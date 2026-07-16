import { describe, expect, it } from 'vitest';
import { fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import { buildVaultTreeRows, type VaultRootState } from '../rows';
import { scanVaultDirectory } from '../scan';

async function readyRoot(rootId: string, dir: ReturnType<typeof fakeDir>): Promise<VaultRootState> {
  const { nodes, noteCount } = await scanVaultDirectory(dir, rootId);
  return { handle: dir, name: dir.name, nodes, noteCount, rootId, status: 'ready' };
}

describe('buildVaultTreeRows', () => {
  it('emits a depth-0 root row per vault with flat descendant rows linked by parentId', async () => {
    const root = await readyRoot(
      'r1',
      fakeDir('vault', [fakeDir('projects', [fakeNote('plan.md')]), fakeNote('inbox.md')])
    );

    const rows = buildVaultTreeRows([root], 'name-asc');

    expect(rows.map((row) => `${row.depth}:${row.type}:${row.id}`)).toEqual([
      '0:vault-root:r1',
      '1:folder:r1:projects',
      '2:note:r1:projects/plan.md',
      '1:note:r1:inbox.md',
    ]);
    expect(rows[0]).toMatchObject({ childCount: 2, hasChildren: true, parentId: null });
    expect(rows[1]).toMatchObject({ childCount: 1, hasChildren: true, parentId: 'r1' });
    expect(rows[2]).toMatchObject({ hasChildren: false, parentId: 'r1:projects' });
    expect(rows[3]).toMatchObject({ hasChildren: false, parentId: 'r1' });
  });

  it('orders siblings by the sort mode within each vault', async () => {
    const root = await readyRoot(
      'r1',
      fakeDir('vault', [
        fakeNote('old.md', { lastModified: 1 }),
        fakeNote('new.md', { lastModified: 2 }),
      ])
    );

    const rows = buildVaultTreeRows([root], 'modified-desc');

    expect(rows.map((row) => row.id)).toEqual(['r1', 'r1:new.md', 'r1:old.md']);
  });

  it('keeps multiple vault roots in mount order and carries row data payloads', async () => {
    const first = await readyRoot('r1', fakeDir('alpha', [fakeNote('a.md')]));
    const second = await readyRoot('r2', fakeDir('beta'));

    const rows = buildVaultTreeRows([first, second], 'name-asc');

    expect(rows.map((row) => row.id)).toEqual(['r1', 'r1:a.md', 'r2']);
    const rootData = rows[0]?.data;
    expect(rootData?.kind).toBe('root');
    if (rootData?.kind === 'root') {
      expect(rootData.root.noteCount).toBe(1);
    }
    const noteData = rows[1]?.data;
    expect(noteData?.kind).toBe('note');
    if (noteData?.kind === 'note') {
      expect(noteData.node.name).toBe('a.md');
    }
    expect(rows[2]).toMatchObject({ hasChildren: false });
  });

  it('marks a scanning root as loading with no children yet', () => {
    const scanning: VaultRootState = {
      handle: fakeDir('pending'),
      name: 'pending',
      nodes: [],
      noteCount: 0,
      rootId: 'r9',
      status: 'scanning',
    };

    const rows = buildVaultTreeRows([scanning], 'name-asc');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hasChildren: false, isLoading: true });
  });
});
