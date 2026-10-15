import { afterEach, describe, expect, it } from 'vitest';
import { webStateNames } from '../protocol';
import { closeTabs, openTab, rejection, storeConfig } from './tabs';

afterEach(closeTabs);

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Overwrites a stored blob's bytes from this page, as disk damage would. */
async function damageBlob(name: string, hash: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const pool = await root.getDirectoryHandle(webStateNames(name).pool);
  const blobs = await pool.getDirectoryHandle('blobs');
  const writable = await (await blobs.getFileHandle(hash)).createWritable();
  await writable.write('not the original bytes');
  await writable.close();
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

  it('refuses an event naming a damaged blob, and refuses to store over it', async () => {
    const config = storeConfig();
    const writer = await openTab(config);
    const content = 'spooled bytes';
    const hash = await sha256(content);
    await writer.putBlob(hash, content);
    await damageBlob(config.name, hash);

    expect((await rejection(writer.append([spooled('thread-b', hash)]))).message).toContain(
      `blob ${hash} checksum mismatch`
    );
    expect((await rejection(writer.putBlob(hash, content))).message).toContain('checksum mismatch');
    expect((await rejection(writer.readBlob(hash, 1000))).message).toContain('checksum mismatch');
    expect(await writer.threads()).toEqual({ threads: [] });
  });

  it('unlinks only the blobs that exist, and a follower tab reaches the same blobs', async () => {
    const config = storeConfig();
    const writer = await openTab(config);
    const follower = await openTab(config);
    const content = 'shared through the writer';
    const hash = await sha256(content);
    await follower.putBlob(hash, content);
    expect(await writer.readBlob(hash, 1000)).toEqual({ content });

    const absent = 'b'.repeat(64);
    expect(await follower.unlinkBlobs([hash, absent])).toEqual({ deleted: [hash] });
    expect((await rejection(writer.readBlob(hash, 1000))).message).toContain('missing');
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
});
