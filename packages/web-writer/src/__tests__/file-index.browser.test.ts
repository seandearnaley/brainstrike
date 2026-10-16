import { sha256Hex } from '@brainstrike/utils/crypto';
import { utf8ByteLength } from '@brainstrike/utils/utf8';
import {
  type WebStateStore,
  type WebStateStoreConfig,
  webRootPath,
  webStateExtensionPool,
  webStateNames,
} from '@brainstrike/web-state-store';
import { afterEach, describe, expect, it } from 'vitest';
import { WebFileIndex } from '../web-writer-client';
import { closeTabs, openTab, storeConfig } from './writer-tabs';

afterEach(closeTabs);

const CONTENT = 'export const canonical = "a canonical web source";\n';

/** A root with one source file in the writer's catalog. */
async function rootWithSource(tab: WebStateStore, path = 'src/one.ts') {
  const rootId = crypto.randomUUID();
  await tab.workspaceRoots({
    operation: 'register',
    root: { displayName: 'project', path: webRootPath(rootId), preferredId: rootId },
  });
  const { files } = await tab.sourceCatalog({
    embeddingSetId: null,
    files: [
      {
        content: CONTENT,
        contentHash: sha256Hex(CONTENT),
        fileName: path.split('/').at(-1) ?? path,
        path,
        stat: { mtimeMs: 1, size: utf8ByteLength(CONTENT) },
      },
    ],
    operation: 'prepare',
    rootId,
  });
  const [file] = files;
  if (!file) {
    throw new Error('prepare returned no file');
  }
  return { file, rootId };
}

/** Publishes the source's text to the file index, as canonical ingestion's publication does. */
async function publish(index: WebFileIndex, rootId: string, fileId: string, path: string) {
  const plan = await index.prepareScopedFile({
    snapshot: {
      chunkLines: 1,
      content: CONTENT,
      embeddingSetId: null,
      fileId,
      relativePath: path,
      rootId,
      sourcePath: `${webRootPath(rootId)}/${path}`,
    },
  });
  return index.commitScopedTextFile({ plan });
}

function search(index: WebFileIndex, rootId: string) {
  return index.searchScopes({
    limit: 10,
    mode: 'bm25',
    scopes: [{ kind: 'workspace', rootId }],
    text: 'canonical',
  });
}

async function poolExists(config: WebStateStoreConfig, part: string): Promise<boolean> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.getDirectoryHandle(webStateExtensionPool(config.name, part).pool);
    return true;
  } catch {
    return false;
  }
}

describe('the file index in a worker of its own', () => {
  it("publishes and searches a root's files for every tab, in its own pool, across a reload", async () => {
    const config = storeConfig();
    const writer = await openTab(config);
    const follower = await openTab(config);
    const { file, rootId } = await rootWithSource(follower);
    const index = new WebFileIndex(follower);
    await index.reauthorize();

    await publish(index, rootId, file.fileId, file.path);
    expect((await search(index, rootId)).hits).toEqual([
      expect.objectContaining({ fileId: file.fileId, relativePath: file.path, rootId }),
    ]);
    expect(await poolExists(config, 'files')).toBe(true);
    writer.close();
    follower.close();

    const reloaded = await openTab(config);
    expect((await search(new WebFileIndex(reloaded), rootId)).hits).toEqual([
      expect.objectContaining({ fileId: file.fileId }),
    ]);
  });

  it('refuses a root registered after it opened, until the writer reauthorizes it', async () => {
    const tab = await openTab(storeConfig());
    const index = new WebFileIndex(tab);
    const { file, rootId } = await rootWithSource(tab);
    await expect(publish(index, rootId, file.fileId, file.path)).rejects.toMatchObject({
      code: 'file-not-authorized',
      name: 'IndexerError',
    });
    await index.reauthorize();
    await publish(index, rootId, file.fileId, file.path);
    expect((await search(index, rootId)).hits).toHaveLength(1);
  });

  it('retires with the store, releasing its pool so factory reset can delete it', async () => {
    const config = storeConfig();
    const tab = await openTab(config);
    const { file, rootId } = await rootWithSource(tab);
    const index = new WebFileIndex(tab);
    await index.reauthorize();
    await publish(index, rootId, file.fileId, file.path);
    await tab.retire();

    const root = await navigator.storage.getDirectory();
    await root.removeEntry(webStateExtensionPool(config.name, 'files').pool, { recursive: true });
    await root.removeEntry(webStateNames(config.name).pool, { recursive: true });
    tab.close();
    const fresh = await openTab(config);
    expect((await fresh.workspaceRoots({ operation: 'list' })).roots).toEqual([]);
  });
});
