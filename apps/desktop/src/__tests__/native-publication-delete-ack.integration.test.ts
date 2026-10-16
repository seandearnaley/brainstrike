// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeCanonicalPublication } from '@brainstrike/canonical-ingestion';
import { openIndexer } from '@brainstrike/indexer';
import { expect, it } from 'vitest';

it('rejects a late commit ACK, then requires a returning canonical identity to republish its real native row', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-publication-ack-'));
  const scope = { embeddingSetId: 'collection', kind: 'collection' } as const;
  const binding = {
    embeddingSetId: scope.embeddingSetId,
    fileId: 'returned-retained',
    profile: null,
    relativePath: null,
    rootId: null,
    sourcePath: null,
  };
  const file = { ...binding, fileName: 'retained.txt' };
  const source = 'canonical retained marker';
  const contentHash = createHash('sha256').update(source).digest('hex');
  const payload = {
    content: source,
    fileId: file.fileId,
    providedChunks: [
      {
        chunkIndex: 0,
        chunkSize: 384,
        chunkType: 'text' as const,
        content: source,
        contentHash,
        endLine: 1,
        endOffset: source.length,
        startLine: 1,
        startOffset: 0,
        tokenCount: 4,
      },
    ],
  };
  const writer = await openIndexer(
    {
      dbPath: path.join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      fileBindings: [binding],
      rootIds: [],
      scopes: [scope],
    },
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
  );
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let holding = true;
  const events: string[] = [];
  const publication = createNativeCanonicalPublication(
    {
      ...writer,
      commitScopedTextFile: async (request: unknown) => {
        const result = await writer.commitScopedTextFile(request);
        entered.resolve();
        if (holding) {
          await gate.promise;
        }
        events.push('commit-ack');
        delivered.resolve();
        return result;
      },
    },
    [scope]
  );
  try {
    const storeId = (await writer.info()).storeId;
    const ticket = await publication.beginScan({ requestId: 'old-generation', scope });
    const committing = publication
      .commitTextFile({ file, payload, ticket })
      .catch((error: unknown) => error);
    await entered.promise;
    // The transaction has committed, but the canonical owner has not received its ACK.
    expect(publication.getReadiness()[0]?.publication).toBeUndefined();
    publication.invalidateFile(file);
    events.push('invalidated');
    const deleting = delivered.promise.then(async () => {
      await writer.removeScopedFile({ fileId: file.fileId, scope });
      events.push('removal-ack');
    });
    gate.resolve();
    const [commitError] = await Promise.all([committing, deleting]);
    expect(commitError).toMatchObject({ message: expect.stringContaining('invalidated') });
    expect(publication.getReadiness()[0]?.publication).toBeUndefined();
    expect(events).toEqual(['invalidated', 'commit-ack', 'removal-ack']);
    await writer.replaceFileBindings([]);
    await publication.abortScan(ticket);
    await publication.finishScan({
      aborted: true,
      errors: [],
      files: [],
      full: true,
      ticket,
      truncatedDirectories: [],
    });
    await writer.replaceFileBindings([binding]);
    const declared = { ...file, contentHash };
    expect(await publication.verifyManifest({ files: [declared], scope })).toMatchObject({
      complete: false,
      missing: [declared],
    });
    const { profile: _profile, ...identity } = binding;
    const plan = await writer.prepareScopedFile({
      snapshot: { ...identity, content: source, providedChunks: payload.providedChunks },
    });
    const nativeFile = {
      ...identity,
      chunks: plan.chunks.map(
        ({ content: _content, embeddingHash: _embeddingHash, ...chunk }) => chunk
      ),
      contentHash,
    };
    expect(await writer.verifyScopedManifest({ files: [nativeFile], scope })).toMatchObject({
      complete: false,
      missing: [nativeFile],
      storeId,
    });
    holding = false;
    const next = await publication.beginScan({ requestId: 'returned-generation', scope });
    await publication.commitTextFile({ file, payload, ticket: next });
    expect(publication.getReadiness()[0]).toMatchObject({
      publication: {
        acknowledgedFiles: 1,
        authorityEpoch: plan.authorityEpoch,
        generation: next.generation,
        profileHash: null,
        requestId: next.requestId,
        storeId,
      },
      scanComplete: false,
    });
    await publication.commitTextFile({ file, payload, ticket: next });
    expect(publication.getReadiness()[0]?.publication?.acknowledgedFiles).toBe(1);
    expect(await publication.verifyManifest({ files: [declared], scope })).toMatchObject({
      complete: true,
    });
    expect(await writer.verifyScopedManifest({ files: [nativeFile], scope })).toMatchObject({
      changed: [],
      complete: true,
      missing: [],
      storeId,
      unexpected: [],
    });
    expect(
      await publication.finishScan({
        aborted: false,
        errors: [],
        files: [declared],
        full: true,
        ticket: next,
        truncatedDirectories: [],
      })
    ).toMatchObject({ scanComplete: true });
  } finally {
    gate.resolve();
    await writer.close();
    await rm(directory, { force: true, recursive: true });
  }
});
