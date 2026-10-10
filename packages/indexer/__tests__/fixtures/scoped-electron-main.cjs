'use strict';
const { app, utilityProcess } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const userData = process.env.BRAINSTRIKE_SCOPED_PROOF_USER_DATA;
assert.ok(userData && path.isAbsolute(userData), 'Disposable Electron userData is required');
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'session-data'));
app
  .whenReady()
  .then(async () => {
    const actualProfile = {
      sessionData: app.getPath('sessionData'),
      userData: app.getPath('userData'),
    };
    assert.equal(actualProfile.userData, userData);
    assert.equal(actualProfile.sessionData, path.join(userData, 'session-data'));
    console.log(`SCOPED_ELECTRON_PROFILE:${JSON.stringify(actualProfile)}`);
    const { createIndexerConnection } = await import('@brainstrike/indexer/transport');
    const { sqliteVecExtensionPath } = await import('@brainstrike/sqlite-native');
    const { decodeIndexIdentityRow } = await import('@brainstrike/indexer/metadata');
    const profile = {
      dimensions: 1536,
      distance: 'cosine',
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    };
    const binding = {
      embeddingSetId: 'collection',
      fileId: 'rootless',
      profile,
      relativePath: null,
      rootId: null,
      sourcePath: null,
    };
    const dbPath = path.join(process.env.BRAINSTRIKE_SCOPED_PROOF_DIR, 'index.sqlite');
    const options = {
      dbPath,
      embedding: { indexMode: 'text-only' },
      fileBindings: [binding],
      rootIds: [],
      scopes: [{ embeddingSetId: 'collection', kind: 'collection' }],
    };
    const start = async () => {
      const child = utilityProcess.fork(path.join(__dirname, 'scoped-electron-utility.cjs'));
      return createIndexerConnection(
        options,
        { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 },
        {
          kill: () => child.kill(),
          onError: (listener) => {
            child.on('error', listener);
            return () => child.off('error', listener);
          },
          onExit: (listener) => {
            child.on('exit', listener);
            return () => child.off('exit', listener);
          },
          onMessage: (listener) => {
            child.on('message', listener);
            return () => child.off('message', listener);
          },
          send: (message) => child.postMessage(message),
        }
      ).ready;
    };
    const port = await start();
    try {
      const info = await port.info();
      assert.notEqual(info.pid, process.pid);
      assert.equal(info.readerQueryOnly, 1);
      assert.ok(info.writerThreadId > 0);
      const { profile: _profile, ...metadata } = binding;
      const snapshot = { ...metadata, chunkLines: 1, content: 'canonical collection source\n' };
      const plan = await port.prepareScopedFile({ profile, snapshot });
      const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
      await port.commitScopedFile({
        embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
        plan,
        profile,
      });
      const query = { limit: 10, mode: 'vector', profile, scopes: options.scopes, vector };
      assert.equal((await port.searchScopes(query)).hits[0].fileId, binding.fileId);
      const manifest = {
        files: [
          {
            ...metadata,
            chunks: plan.chunks.map(
              ({ content: _content, embeddingHash: _hash, ...chunk }) => chunk
            ),
            contentHash: plan.contentHash,
          },
        ],
        scope: options.scopes[0],
      };
      const verified = await port.verifyScopedManifest(manifest);
      assert.equal(verified.complete, true);
      const coverage = await port.coverageScope({ profile, scope: manifest.scope });
      assert.equal(coverage.vectorCoverageComplete, true);
      assert.deepEqual(coverage.counts, {
        chunks: 1,
        indexedFiles: 1,
        missingVectors: 0,
        vectors: 1,
      });
      assert.equal(coverage.authorityEpoch, verified.authorityEpoch);
      assert.equal((await port.coverageScope({ scope: manifest.scope })).counts.vectors, 0);
      const reader = new DatabaseSync(dbPath, { allowExtension: true, readOnly: true });
      try {
        reader.loadExtension(sqliteVecExtensionPath());
        reader.exec('PRAGMA query_only=ON');
        const identity = decodeIndexIdentityRow(
          reader
            .prepare(
              'SELECT schema_version AS schemaVersion,store_id AS storeId,index_mode AS indexMode,profile_json AS profileJson,profile_hash AS profileHash FROM index_metadata'
            )
            .get()
        );
        assert.equal(identity.storeId, info.storeId);
        assert.equal(
          reader.prepare('SELECT count(*) AS n FROM scoped_vectors WHERE dimensions=1536').get().n,
          1
        );
        assert.equal(
          reader
            .prepare('SELECT vec_distance_cosine(emb,emb) AS distance FROM scoped_vectors')
            .get().distance,
          0
        );
      } finally {
        reader.close();
      }
      await port.close();
      const reopened = await start();
      try {
        assert.equal((await reopened.searchScopes(query)).hits[0].rootId, null);
        const source = await reopened.verifyScopedManifest(manifest);
        assert.equal(source.complete, true);
        assert.equal(source.storeId, verified.storeId);
        assert.notEqual(source.authorityEpoch, verified.authorityEpoch);
        assert.equal(
          (await reopened.coverageScope({ profile, scope: manifest.scope })).vectorCoverageComplete,
          true
        );
        await reopened.destroy();
      } finally {
        await reopened.close();
      }
      console.log(`SCOPED_ELECTRON_PROOF_OK:${process.versions.electron}`);
      app.quit();
    } finally {
      await port.close();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
