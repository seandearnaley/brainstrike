import { afterEach, describe, expect, it } from 'vitest';
import { webRootPath } from '../protocol';
import { closeTabs, openTab, rejection, storeConfig } from './tabs';

afterEach(closeTabs);

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function spooled(threadId: string, blob: string) {
  return [
    threadId,
    'tool.output',
    'run-1',
    JSON.stringify({ blob, type: 'tool.output' }),
    null,
    1,
  ] as const;
}

describe('blobs on the browser writer', () => {
  it('stores a blob durably before an event names it, and reads it back verified after a reload', async () => {
    const config = storeConfig();
    const writer = await openTab(config);
    const content = `tool output ✓ ${'x'.repeat(20_000)}`;
    const hash = await sha256(content);

    expect(await writer.putBlob(hash, content)).toEqual({});
    // Storing the same bytes again keeps the blob.
    expect(await writer.putBlob(hash, content)).toEqual({});
    expect((await writer.append([spooled('thread-a', hash)], { boundary: true })).seqs).toEqual([
      1,
    ]);
    expect(await writer.storedBlobRefs('thread-a')).toEqual({ hashes: [hash] });
    writer.close();

    const reloaded = await openTab(config);
    expect(await reloaded.readBlob(hash, 1_000_000)).toEqual({ content });
    expect(await reloaded.readBlob(hash, 100)).toEqual({ content: null });
  });

  it('refuses a blob whose hash does not match its content', async () => {
    const writer = await openTab(storeConfig());
    const error = await rejection(writer.putBlob(await sha256('one'), 'two'));
    expect(error.message).toContain('blob hash does not match its content');
  });

  it('serves a follower the same blobs, and refuses deletion without the derived index that counts them', async () => {
    const config = storeConfig();
    const writer = await openTab(config);
    const follower = await openTab(config);
    const content = 'shared through the writer';
    const hash = await sha256(content);
    await follower.putBlob(hash, content);
    await follower.append([spooled('thread-a', hash)], { boundary: true });
    expect(await writer.readBlob(hash, 1000)).toEqual({ content });

    // Only the writer's purge and thread delete remove blobs, and only with reference counts.
    for (const refused of [follower.deleteThread('thread-a'), follower.purge('thread-a', 1)]) {
      expect((await rejection(refused)).message).toContain('needs the indexer port');
    }
    expect(await writer.threads()).toEqual({ threads: ['thread-a'] });
    expect(await writer.readBlob(hash, 1000)).toEqual({ content });
  });
});

describe('catalogs on the browser writer', () => {
  it('serves collections, thread groups, presets, model choices and prompts to every tab', async () => {
    const config = storeConfig();
    const writer = await openTab(config);
    const follower = await openTab(config);
    const collection = {
      createdAt: '2026-10-13T19:45:00.000Z',
      dimensions: 384,
      distance: 'cosine' as const,
      id: 'collection-one',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      name: 'Project reference',
    };

    expect(await follower.collections({ collection, operation: 'create' })).toEqual({
      collections: [collection],
    });
    expect(await writer.collections({ operation: 'snapshot' })).toEqual({
      collections: [collection],
      counts: [{ chunks: 0, files: 0, id: collection.id, unprocessedFiles: 0 }],
    });

    const group = {
      color: 'rose' as const,
      icon: 'code' as const,
      id: 'group-one',
      name: 'Current work',
      rank: 'a0',
      resourceId: 'brainstrike:workspace',
    };
    await follower.threadGroups({ group, operation: 'create' });
    expect(await writer.threadGroups({ operation: 'list', resourceId: group.resourceId })).toEqual({
      groups: [group],
      placements: [],
    });

    const presets = await follower.viewFilterPresets({ operation: 'list' });
    expect(presets.presets.length).toBeGreaterThan(0);
    expect(
      await writer.viewFilterPresets({ id: presets.presets[0]?.id ?? '', operation: 'delete' })
    ).toMatchObject({ deleted: false });

    await follower.modelChoices({ enabled: true, operation: 'provider', providerId: 'openai' });
    expect((await writer.modelChoices({ operation: 'snapshot' })).providers).toEqual([
      { enabled: true, providerId: 'openai' },
    ]);

    const created = await follower.promptCatalog({
      input: { content: 'Review {{path}}.', id: 'prompt-one', kind: 'prompt', title: 'Review' },
      operation: 'create',
    });
    expect(created.items[0]).toMatchObject({ id: 'prompt-one', revision: 1 });
    expect((await writer.promptCatalog({ filter: {}, operation: 'list' })).items).toHaveLength(1);

    // A domain refusal reaches the caller as a failed request, with nothing written.
    const refused = await rejection(
      follower.collections({ collection: { ...collection, modelId: 'other' }, operation: 'create' })
    );
    expect(refused.kind).toBe('failed');
    expect((await writer.collections({ operation: 'list' })).collections).toEqual([collection]);
  });
  it('keeps workspace roots without the derived index, but refuses a source change or root deletion it would need', async () => {
    const config = storeConfig();
    const writer = await openTab(config);
    const follower = await openTab(config);
    const rootId = crypto.randomUUID();
    const root = { displayName: 'project', path: webRootPath(rootId), preferredId: rootId };
    await follower.workspaceRoots({ operation: 'register', root });
    expect((await writer.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({ id: rootId, status: 'live' }),
    ]);
    // A key that names another root would file its handle under the wrong id.
    expect(
      (
        await rejection(
          follower.workspaceRoots({
            operation: 'register',
            root: { ...root, preferredId: crypto.randomUUID() },
          })
        )
      ).message
    ).toContain('granted absolute path');
    // A desktop path is not a root this host was granted.
    expect(
      (
        await rejection(
          follower.workspaceRoots({
            operation: 'register',
            root: { displayName: 'os', path: '/home/user/project', preferredId: 'os' },
          })
        )
      ).message
    ).toContain('granted absolute path');

    const content = 'export const one = 1;\n';
    const file = {
      content,
      contentHash: await sha256(content),
      fileName: 'one.ts',
      path: 'src/one.ts',
      stat: { mtimeMs: 1, size: content.length },
    };
    for (const refused of [
      follower.sourceCatalog({ embeddingSetId: null, files: [file], operation: 'prepare', rootId }),
      follower.workspaceRoots({ operation: 'delete', paths: [root.path], rootId }),
    ]) {
      expect((await rejection(refused)).message).toContain('needs the indexer port');
    }
    expect((await writer.sourceCatalog({ operation: 'list' })).files).toEqual([]);
    expect((await writer.workspaceRoots({ operation: 'list' })).roots).toHaveLength(1);
  });
});
