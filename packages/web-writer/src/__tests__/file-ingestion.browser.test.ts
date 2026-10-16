import { type WebStateStore, webRootPath } from '@brainstrike/web-state-store';
import { afterEach, describe, expect, it } from 'vitest';
import { WebFileIndex } from '../web-writer-client';
import { closeTabs, openTab, storeConfig } from './writer-tabs';

const folders: string[] = [];

afterEach(async () => {
  await closeTabs();
  const opfs = await navigator.storage.getDirectory();
  for (const name of folders.splice(0)) {
    await opfs.removeEntry(name, { recursive: true }).catch(() => undefined);
  }
});

async function write(
  folder: FileSystemDirectoryHandle,
  path: string,
  content: string | Uint8Array<ArrayBuffer>
): Promise<void> {
  const parts = path.split('/');
  let directory = folder;
  for (const part of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  const file = await directory.getFileHandle(parts.at(-1) ?? path, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}

/** A folder the tab holds a grant for: an OPFS directory, which needs no prompt. */
async function grantedFolder(files: Readonly<Record<string, string | Uint8Array<ArrayBuffer>>>) {
  const name = `folder-${crypto.randomUUID()}`;
  folders.push(name);
  const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, {
    create: true,
  });
  for (const [path, content] of Object.entries(files)) {
    await write(folder, path, content);
  }
  return { folder, rootId: crypto.randomUUID() };
}

async function register(tab: WebStateStore, rootId: string): Promise<void> {
  await tab.workspaceRoots({
    operation: 'register',
    root: { displayName: 'project', path: webRootPath(rootId), preferredId: rootId },
  });
}

async function search(index: WebFileIndex, rootId: string, text: string) {
  return (
    await index.searchScopes({
      limit: 20,
      mode: 'bm25',
      scopes: [{ kind: 'workspace', rootId }],
      text,
    })
  ).hits;
}

async function catalogPaths(tab: WebStateStore, rootId: string): Promise<string[]> {
  return (await tab.sourceCatalog({ operation: 'list' })).files
    .filter((file) => file.rootId === rootId)
    .map((file) => file.path)
    .sort();
}

describe('canonical ingestion in the file index worker', () => {
  it('scans a granted folder into the catalog and the index, and follows its edits and deletions', async () => {
    const { folder, rootId } = await grantedFolder({
      'docs/notes.md': '# Notes\n\nThe zebrafish migration plan, café 🧠.\n',
      'image.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      'src/greeter.py': 'class Greeter:\n    def greet(self):\n        return "hello kestrel"\n',
      'src/one.ts': 'export const answer = "the quokka constant";\n',
    });
    const config = storeConfig();
    const writer = await openTab(config);
    const follower = await openTab(config);
    await register(follower, rootId);
    const index = new WebFileIndex(follower);

    // The follower hands the writer its folder; the writer's index worker reads it.
    expect(await index.scan(rootId, folder)).toMatchObject({
      reason: 'complete',
      scanComplete: true,
    });
    // Every text source is in the catalog; the binary file is excluded.
    expect(await catalogPaths(writer, rootId)).toEqual([
      'docs/notes.md',
      'src/greeter.py',
      'src/one.ts',
    ]);
    for (const [text, path] of [
      ['quokka', 'src/one.ts'],
      ['kestrel', 'src/greeter.py'],
      ['zebrafish', 'docs/notes.md'],
    ] as const) {
      expect((await search(index, rootId, text)).map((hit) => hit.relativePath)).toEqual([path]);
    }

    // An edit and a deletion reach the catalog and the index on the next scan.
    await write(folder, 'src/one.ts', 'export const answer = "the pangolin constant";\n');
    await (await folder.getDirectoryHandle('docs')).removeEntry('notes.md');
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });
    expect(await search(index, rootId, 'quokka')).toEqual([]);
    expect((await search(index, rootId, 'pangolin')).map((hit) => hit.relativePath)).toEqual([
      'src/one.ts',
    ]);
    expect(await search(index, rootId, 'zebrafish')).toEqual([]);
    expect(await catalogPaths(writer, rootId)).toEqual(['src/greeter.py', 'src/one.ts']);
    writer.close();
    follower.close();

    // The catalog and the index both survive a reload.
    const reloaded = await openTab(config);
    expect((await search(new WebFileIndex(reloaded), rootId, 'kestrel')).length).toBe(1);
    expect(await catalogPaths(reloaded, rootId)).toEqual(['src/greeter.py', 'src/one.ts']);
  });

  it('refuses a root that is not live, and another folder for a root already ingesting one', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const other = await grantedFolder({ 'two.ts': 'export const two = 2;\n' });
    const tab = await openTab(storeConfig());
    const index = new WebFileIndex(tab);
    await expect(index.scan(rootId, folder)).rejects.toThrow('Only a live workspace root');

    await register(tab, rootId);
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });
    await expect(index.scan(rootId, other.folder)).rejects.toThrow('another folder');
    expect(await catalogPaths(tab, rootId)).toEqual(['one.ts']);
  });
  it('fails a scan whose pass fails, rather than leaving it waiting', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const index = new WebFileIndex(tab);
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });

    // The folder goes away under the root: the next pass cannot list it.
    await (await navigator.storage.getDirectory()).removeEntry(folder.name, { recursive: true });
    await expect(index.scan(rootId, folder)).rejects.toThrow();
    expect(await catalogPaths(tab, rootId)).toEqual(['one.ts']);
  });
  it('answers each of two concurrent scans with its own pass, not the one already running', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const index = new WebFileIndex(tab);
    const [first, second] = await Promise.all([
      index.scan(rootId, folder),
      index.scan(rootId, folder),
    ]);
    expect(first).toMatchObject({ scanComplete: true });
    expect(second).toMatchObject({ scanComplete: true });
    expect(second.ticket.requestId).not.toBe(first.ticket.requestId);
  });

  it('refuses a scan of a root deleted since its runtime started', async () => {
    const { folder, rootId } = await grantedFolder({ 'one.ts': 'export const one = 1;\n' });
    const tab = await openTab(storeConfig());
    await register(tab, rootId);
    const index = new WebFileIndex(tab);
    expect(await index.scan(rootId, folder)).toMatchObject({ scanComplete: true });

    await tab.workspaceRoots({ operation: 'delete', paths: [webRootPath(rootId)], rootId });
    await expect(index.scan(rootId, folder)).rejects.toThrow('Only a live workspace root');
    expect(await catalogPaths(tab, rootId)).toEqual([]);
  });
});
