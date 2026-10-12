import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { expect, it } from 'vitest';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
it('verifies exact authorized native manifests instead of equal file counts and survives reopen', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-index-manifest-'));
  const dbPath = path.join(directory, 'index.sqlite');
  let port = await openIndexer(
    { dbPath, embedding: { indexMode: 'text-only' }, rootIds: ['a', 'b'] },
    deadlines
  );
  const expected = [{ contentHash: hash('canonical source'), fileId: 'f', relativePath: 'f.ts' }];
  const request = { files: expected, rootId: 'a' };
  try {
    const empty = await port.verifyManifest(request);
    expect(empty).toMatchObject({
      changed: [],
      complete: false,
      missing: expected,
      unexpected: [],
    });
    const write = async (
      fileId: string,
      content: string,
      relativePath = `${fileId}.ts`,
      rootId = 'a'
    ): Promise<void> => {
      const plan = await port.prepareFile({ chunkLines: 1, content, fileId, relativePath, rootId });
      await port.commitTextFile({ plan });
    };
    await write('wrong', 'canonical source');
    const sameCount = await port.verifyManifest(request);
    expect(sameCount).toMatchObject({
      complete: false,
      missing: expected,
      unexpected: [{ fileId: 'wrong' }],
    });
    await port.removeFile({ fileId: 'wrong', rootId: 'a' });
    await write('f', 'different');
    expect((await port.verifyManifest(request)).changed).toEqual(expected);
    await write('f', 'canonical source', 'shifted.ts');
    expect((await port.verifyManifest(request)).changed).toEqual(expected);
    await write('f', 'canonical source');
    await write('foreign', 'canonical source', 'foreign.ts', 'b');
    const verified = await port.verifyManifest(request);
    expect(verified).toEqual({
      complete: true,
      rootId: 'a',
      ...(await port.info().then(({ embedding, storeId }) => ({ embedding, storeId }))),
      changed: [],
      missing: [],
      unexpected: [],
    });
    await expect(port.verifyManifest({ files: [], rootId: 'foreign' })).rejects.toThrow(
      'not authorized'
    );
    await expect(
      port.verifyManifest({ files: [...expected, ...expected], rootId: 'a' })
    ).rejects.toThrow();
    await expect(
      port.verifyManifest({
        files: [{ ...expected[0], relativePath: '../outside.ts' }],
        rootId: 'a',
      })
    ).rejects.toThrow();
    await expect(port.verifyManifest({ ...request, count: 1 })).rejects.toThrow();
    await port.close();
    port = await openIndexer(
      { dbPath, embedding: { indexMode: 'open-existing' }, rootIds: ['a'] },
      deadlines
    );
    expect(await port.verifyManifest(request)).toEqual(verified);
    expect((await port.verifyManifest({ files: [], rootId: 'a' })).complete).toBe(false);
    await port.removeFile({ fileId: 'f', rootId: 'a' });
    expect((await port.verifyManifest({ files: [], rootId: 'a' })).complete).toBe(true);
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});
