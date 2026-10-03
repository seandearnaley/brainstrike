import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openIndexer } from '@brainstrike/indexer';

const fixture = JSON.parse(
  await readFile(new URL('./callers-runtime.json', import.meta.url), 'utf8')
);
const bytes = await readFile(new URL('./callers-runtime.f32', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.provenance.vectorsSha256);
const port = await openIndexer(
  {
    dbPath: process.argv[2],
    embedding: { indexMode: 'vector-configured', profile: fixture.profile },
    rootIds: ['recorded-root'],
  },
  { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
);
try {
  const identities = [];
  for (const [fileIndex, file] of fixture.files.entries()) {
    assert.equal(createHash('sha256').update(file.source).digest('hex'), file.sourceHash);
    const fileId = `recorded-file-${fileIndex}`;
    const plan = await port.prepareFile({
      content: file.source,
      fileId,
      providedChunks: file.chunks.map((entry) => entry.chunk),
      relativePath: file.path,
      rootId: 'recorded-root',
    });
    await port.commitFile({
      embeddings: plan.chunks.map((chunk) => {
        const entry = file.chunks.find((value) => value.chunk.chunkIndex === chunk.chunkIndex);
        assert.ok(entry);
        return {
          chunkId: chunk.chunkId,
          vector: Array.from({ length: 384 }, (_, index) =>
            bytes.readFloatLE((entry.fixtureVectorIndex * 384 + index) * 4)
          ),
        };
      }),
      plan,
      profile: fixture.profile,
      syntax: {
        refs: file.refs.map(({ enclosingSymbolIndex, ...ref }, seq) => ({
          ...ref,
          fileRecordId: fileId,
          seq,
          ...(enclosingSymbolIndex === undefined ? {} : { fromSymbolSeq: enclosingSymbolIndex }),
        })),
        symbols: file.symbols.map((symbol, seq) => ({ ...symbol, fileRecordId: fileId, seq })),
      },
    });
    identities.push({ chunks: plan.chunks, fileId, path: file.path });
  }
  // Deliberate unreachable control: exact recorded seed bytes/vectors without graph rows.
  const seed = fixture.files[0];
  const plan = await port.prepareFile({
    content: seed.source,
    fileId: 'bait',
    providedChunks: seed.chunks.map((entry) => entry.chunk),
    relativePath: 'control/unreachable.ts',
    rootId: 'recorded-root',
  });
  await port.commitFile({
    embeddings: plan.chunks.map((chunk) => {
      const entry = seed.chunks.find((value) => value.chunk.chunkIndex === chunk.chunkIndex);
      assert.ok(entry);
      return {
        chunkId: chunk.chunkId,
        vector: Array.from({ length: 384 }, (_, index) =>
          bytes.readFloatLE((entry.fixtureVectorIndex * 384 + index) * 4)
        ),
      };
    }),
    plan,
    profile: fixture.profile,
  });
  if (process.argv[3] === 'many' || process.argv[3] === 'depth') {
    const file = fixture.files[1];
    const depth = process.argv[3] === 'depth';
    if (depth) {
      // Deliberate graph control, using original parser row types/spans.
      const { openConnection } = await import('@brainstrike/sqlite-native');
      const writer = openConnection(process.argv[2]);
      writer.exec('DELETE FROM file_symbol_refs; DELETE FROM file_symbols;');
      writer
        .prepare('INSERT INTO file_symbols VALUES(?,?,?,?,?,?,?,?,?)')
        .run('recorded-file-0', 0, 'hop0', 'function', 0, 50, 67, 1678, 2194);
      writer.close();
    }
    for (let index = 1; index <= (depth ? 11 : 55); index += 1) {
      const fileId = `controlled-${index}`;
      const extra = await port.prepareFile({
        content: file.source,
        fileId,
        providedChunks: file.chunks.map((entry) => entry.chunk),
        relativePath: `control/${depth ? 'depth' : 'many'}-${index}.ts`,
        rootId: 'recorded-root',
      });
      await port.commitFile({
        embeddings: extra.chunks.map((chunk) => {
          const entry = file.chunks.find((value) => value.chunk.chunkIndex === chunk.chunkIndex);
          assert.ok(entry);
          return {
            chunkId: chunk.chunkId,
            vector: Array.from({ length: 384 }, (_, i) =>
              bytes.readFloatLE((entry.fixtureVectorIndex * 384 + i) * 4)
            ),
          };
        }),
        plan: extra,
        profile: fixture.profile,
        syntax: {
          refs: [
            {
              fileRecordId: fileId,
              fromSymbolSeq: 0,
              kind: 'call',
              line: 32,
              name: depth ? `hop${index - 1}` : 'add',
              seq: 0,
            },
          ],
          symbols: [
            {
              ...file.symbols[1],
              fileRecordId: fileId,
              name: depth ? `hop${index}` : file.symbols[1].name,
              seq: 0,
            },
          ],
        },
      });
    }
    if (depth) {
      const { openConnection } = await import('@brainstrike/sqlite-native');
      const writer = openConnection(process.argv[2]);
      // Cycle hop1 -> hop0 -> hop1 must remain bounded by depth10.
      writer
        .prepare('INSERT INTO file_symbol_refs VALUES(?,?,?,?,?,?,?)')
        .run('recorded-file-0', 0, 0, 'hop1', 'call', null, 52);
      writer.close();
    }
  }
  const seedChunk = identities[0].chunks
    .filter((chunk) => chunk.startLine <= 50 && chunk.endLine >= 50)
    .sort((a, b) => (a.chunkId < b.chunkId ? -1 : 1))[0];
  assert.ok(seedChunk);
  const recorded = identities.flatMap((identity, i) =>
    identity.chunks.map((chunk) => {
      const entry = fixture.files[i].chunks.find(
        (value) => value.chunk.chunkIndex === chunk.chunkIndex
      );
      assert.ok(entry);
      return {
        id: chunk.chunkId,
        vector: Array.from({ length: 384 }, (_, index) =>
          bytes.readFloatLE((entry.fixtureVectorIndex * 384 + index) * 4)
        ),
      };
    })
  );
  const seedVector = recorded.find((entry) => entry.id === seedChunk.chunkId).vector;
  const expectedVectorIds = recorded
    .map((entry) => {
      let dot = 0;
      let seedNorm = 0;
      let norm = 0;
      for (let index = 0; index < 384; index += 1) {
        dot += entry.vector[index] * seedVector[index];
        seedNorm += seedVector[index] ** 2;
        norm += entry.vector[index] ** 2;
      }
      return { distance: 1 - dot / Math.sqrt(norm * seedNorm), id: entry.id };
    })
    .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1))
    .map((entry) => entry.id);
  const info = await port.info();
  assert.equal(info.embedding.profileHash, fixture.provenance.profileHash);
  console.log(JSON.stringify({ expectedVectorIds, identities, info }));
} finally {
  await port.close();
}
