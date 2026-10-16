import { sha256Hex } from '@brainstrike/utils/crypto';
import { utf8ByteLength } from '@brainstrike/utils/utf8';
import { webRootPath } from '@brainstrike/web-state-store';
import { afterEach, describe, expect, it } from 'vitest';
import { WebDerivedIndex } from '../web-writer-client';
import { closeTabs, corpus, openTab, storeConfig, storeCorpus } from './writer-tabs';

afterEach(closeTabs);

function source(path: string, content: string) {
  return {
    content,
    contentHash: sha256Hex(content),
    fileName: path.split('/').at(-1) ?? path,
    path,
    stat: { mtimeMs: 1, size: utf8ByteLength(content) },
  };
}

describe('the source catalog and workspace roots in the browser writer', () => {
  it('serves every tab, and collects the bytes a replacement or a root deletion retires', async () => {
    const config = storeConfig();
    const writer = await openTab(config);
    const follower = await openTab(config);
    const rootId = crypto.randomUUID();
    const root = { displayName: 'project', path: webRootPath(rootId), preferredId: rootId };
    await follower.workspaceRoots({ operation: 'register', root });
    expect((await writer.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({ id: rootId, path: root.path, status: 'live' }),
    ]);

    const one = source('src/one.ts', 'export const one = 1;\n');
    const notes = source('docs/notes.md', 'Notes, café 🧠\n');
    const prepared = await follower.sourceCatalog({
      embeddingSetId: null,
      files: [one, notes],
      operation: 'prepare',
      rootId,
    });
    expect(await writer.readBlob(one.contentHash, 1000)).toEqual({ content: one.content });
    const [current] = prepared.files;
    if (!current) {
      throw new Error('prepare returned no file');
    }

    // The replaced bytes are named by nothing, so the writer's GC removes them.
    const two = source('src/one.ts', 'export const one = 2;\n');
    await follower.sourceCatalog({
      files: [{ expected: current, source: two }],
      operation: 'replace',
    });
    await expect(writer.readBlob(one.contentHash, 1000)).rejects.toThrow('missing');
    expect(await writer.readBlob(two.contentHash, 1000)).toEqual({ content: two.content });

    // Deleting the root deletes its sources, and their bytes.
    await follower.workspaceRoots({ operation: 'delete', paths: [root.path], rootId });
    expect((await writer.workspaceRoots({ operation: 'list' })).roots).toEqual([]);
    expect((await writer.sourceCatalog({ operation: 'list' })).files).toEqual([]);
    for (const hash of [two.contentHash, notes.contentHash]) {
      await expect(writer.readBlob(hash, 1000)).rejects.toThrow('missing');
    }
    writer.close();
    follower.close();

    const reloaded = await openTab(config);
    expect((await reloaded.workspaceRoots({ operation: 'list' })).roots).toEqual([]);
    expect((await reloaded.sourceCatalog({ operation: 'list' })).files).toEqual([]);
  });

  it("keeps a removed source's bytes while a run event still names them", async () => {
    const tab = await openTab(storeConfig());
    await storeCorpus(tab);
    await new WebDerivedIndex(tab).catchUp();
    // An imported source whose bytes are also a blob the corpus's runs name.
    const [hash, content] = corpus.blobs[0] ?? [];
    if (!(hash && content)) {
      throw new Error('The corpus names no blob');
    }
    const imported = await tab.sourceCatalog({
      embeddingSetId: null,
      files: [source('imports/shared.json', content)],
      operation: 'import',
    });
    expect(imported.files[0]?.contentHash).toBe(hash);

    await tab.sourceCatalog({ files: imported.files, operation: 'remove' });
    expect((await tab.sourceCatalog({ operation: 'list' })).files).toEqual([]);
    expect((await tab.readBlob(hash, 1_000_000)).content).toBe(content);
  });
});
