import { describe, expect, it } from 'vitest';
import { fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import { scanVaultDirectory } from '../scan';
import type { VaultFolderNode, VaultNoteNode } from '../types';

const ROOT_ID = 'root-1';

describe('scanVaultDirectory', () => {
  it('lists markdown notes with identity and metadata', async () => {
    const root = fakeDir('vault', [
      fakeNote('alpha.md', { content: '# Alpha', lastModified: 111 }),
      fakeNote('beta.markdown', { content: 'beta body', lastModified: 222 }),
    ]);

    const result = await scanVaultDirectory(root, ROOT_ID);

    expect(result.noteCount).toBe(2);
    const notes = result.nodes.filter((node): node is VaultNoteNode => node.type === 'note');
    const alpha = notes.find((note) => note.name === 'alpha.md');
    expect(alpha).toMatchObject({
      id: `${ROOT_ID}:alpha.md`,
      lastModified: 111,
      pathSegments: ['alpha.md'],
      rootId: ROOT_ID,
      size: '# Alpha'.length,
      type: 'note',
    });
    expect(notes.map((note) => note.name).sort()).toEqual(['alpha.md', 'beta.markdown']);
  });

  it('ignores non-markdown files but keeps folders, matching extensions case-insensitively', async () => {
    const root = fakeDir('vault', [
      fakeNote('keep.MD', { lastModified: 5 }),
      fakeNote('photo.png'),
      fakeNote('script.ts'),
      fakeDir('empty-folder'),
    ]);

    const result = await scanVaultDirectory(root, ROOT_ID);

    expect(result.noteCount).toBe(1);
    expect(result.nodes.map((node) => node.name).sort()).toEqual(['empty-folder', 'keep.MD']);
    const folder = result.nodes.find((node) => node.type === 'folder');
    expect(folder).toMatchObject({ children: [], lastModified: 0, noteCount: 0 });
  });

  it('skips hidden dot-prefixed files and directories entirely', async () => {
    const root = fakeDir('vault', [
      fakeNote('.hidden.md'),
      fakeDir('.obsidian', [fakeNote('config.md')]),
      fakeNote('visible.md'),
    ]);

    const result = await scanVaultDirectory(root, ROOT_ID);

    expect(result.noteCount).toBe(1);
    expect(result.nodes.map((node) => node.name)).toEqual(['visible.md']);
  });

  it('recurses into folders, aggregating noteCount and max descendant lastModified', async () => {
    const root = fakeDir('vault', [
      fakeDir('projects', [
        fakeNote('roadmap.md', { lastModified: 300 }),
        fakeDir('archive', [fakeNote('old.md', { lastModified: 900 })]),
      ]),
      fakeNote('inbox.md', { lastModified: 50 }),
    ]);

    const result = await scanVaultDirectory(root, ROOT_ID);

    expect(result.noteCount).toBe(3);
    const projects = result.nodes.find(
      (node): node is VaultFolderNode => node.type === 'folder' && node.name === 'projects'
    );
    expect(projects).toBeDefined();
    expect(projects?.noteCount).toBe(2);
    expect(projects?.lastModified).toBe(900);
    expect(projects?.id).toBe(`${ROOT_ID}:projects`);

    const archive = projects?.children.find(
      (node): node is VaultFolderNode => node.type === 'folder'
    );
    expect(archive?.pathSegments).toEqual(['projects', 'archive']);
    expect(archive?.id).toBe(`${ROOT_ID}:projects/archive`);
    const old = archive?.children[0];
    expect(old?.pathSegments).toEqual(['projects', 'archive', 'old.md']);
  });

  it('supports aborting a scan in progress', async () => {
    const controller = new AbortController();
    controller.abort();
    const root = fakeDir('vault', [fakeNote('a.md')]);

    await expect(
      scanVaultDirectory(root, ROOT_ID, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
