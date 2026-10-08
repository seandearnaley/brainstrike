import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createNativeScopedSearchCapability,
  createNodeNativeTextServices,
  NativeAuthorityTransitionError,
  NativeCoverageObservationInvalidatedError,
  NativeIndexBlockedError,
  NativeIndexSetupRequiredError,
  NativeReadAuthorityRetiredError,
} from '@brainstrike/assistant-service/node-native-text-services';
import {
  createNodeProfileDatabaseOwner,
  joinProfileDirectory,
  openExistingNodeWorkspaceServices,
} from '@brainstrike/assistant-service/node-workspace-services';
import { openIndexer } from '@brainstrike/indexer';
import {
  SqliteQueryClient,
  SqliteQueryStartupCleanupError,
  spawnQueryProcess,
} from '@brainstrike/sqlite-query';
import { RootLock, StateStore } from '@brainstrike/state-store';

const [mode, fixture, capturedPath, ownerBundles] = process.argv.slice(2);
assert.ok(mode && fixture && capturedPath && ownerBundles);
assert.equal(process.versions.electron, undefined);
const original = (name) => import(pathToFileURL(path.join(ownerBundles, `${name}.mjs`)).href);
const { createNativeIndexRuntime, NativeReadAuthorityRetiredError: desktopRetired } =
  await original('native-index-runtime');
const { createNativeIndexReadAuthority } = await original('native-index-read-authority');
const { createNativeCanonicalPublication } = await original('native-canonical-publication');
const { readNativeIndexSettings, NATIVE_INDEX_SETTINGS_KEY, nativeIndexConfigurationIdentity } =
  await original('native-index-settings');
assert.equal(desktopRetired, NativeReadAuthorityRetiredError);
for (const [name, exportName, expectedClass] of [
  ['native-authority-transition', 'NativeAuthorityTransitionError', NativeAuthorityTransitionError],
  [
    'native-coverage-observation-invalidated',
    'NativeCoverageObservationInvalidatedError',
    NativeCoverageObservationInvalidatedError,
  ],
  ['native-index-blocked', 'NativeIndexBlockedError', NativeIndexBlockedError],
  ['native-index-setup-required', 'NativeIndexSetupRequiredError', NativeIndexSetupRequiredError],
]) {
  assert.equal((await original(name))[exportName], expectedClass);
}
assert.equal(
  (await original('native-scoped-search')).createNativeScopedSearchCapability,
  createNativeScopedSearchCapability
);
const captured = JSON.parse(await readFile(capturedPath, 'utf8'));
const content = captured.content;
assert.equal(createHash('sha256').update(content).digest('hex'), captured.sourceHash);
const relativePath = captured.relativePath;
const location = { profile: 'selected', rootPath: fixture, source: 'test' };
const profileDirectory = joinProfileDirectory(fixture, 'selected');
const dbPath = path.join(profileDirectory, 'index.sqlite');
const workspace = path.join(fixture, 'workspace');
const foreignWorkspace = path.join(fixture, 'foreign-workspace');
const ledger = path.join(fixture, 'existing-grants.json');
const seedPath = path.join(fixture, 'canonical-seed.json');
const rootId = 'b5f5883e-c414-485a-9c1b-1b43a579ca10';
const foreignRootId = 'ea7ea99d-b5dc-48c0-9a80-d702f63c9361';
const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const shutdown = new AbortController();
const pendingTails = new Set();
process.once('SIGTERM', () => {
  shutdown.abort(new Error('Native TEXT fixture was stopped by its test owner.'));
  for (const tail of pendingTails) {
    tail.release.resolve();
  }
  searchTail?.release.resolve();
});
const context = () => ({ requestId: randomUUID(), signal: shutdown.signal });
const children = () =>
  process._getActiveHandles().filter((handle) => handle instanceof ChildProcess);
const queryOwners = new Set();
const queryAcquisitions = new Set();
let services;
let store;
let seedOwner;
let runtime;
let runtimeClose;
let servicesClose;
let storeClose;
let seedClose;
let publication;
let graph;
let port;
let searchTail;
let ownerCount = 0;
let readCount = 0;
let lease;
const receipt = { constructorIdentity: true, electron: false, mode };
const joinQueries = async () => {
  await Promise.allSettled([...queryAcquisitions]);
  const joined = await Promise.allSettled([...queryOwners].map((owner) => owner.close()));
  const failures = joined.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length) {
    throw new AggregateError(failures, 'Native TEXT fixture reader retirement failed.');
  }
};
const openQuery = () => {
  const pending = SqliteQueryClient.open({
    databasePath: dbPath,
    deadlineMs: 5000,
    spawn: () =>
      spawnQueryProcess({
        executable: process.env.SQLITE_QUERY_TEST_EXEC_PATH ?? process.execPath,
        ...(process.env.SQLITE_QUERY_TEST_EXEC_PATH
          ? { environment: { ELECTRON_RUN_AS_NODE: '1' } }
          : {}),
      }),
    startupDeadlineMs: 5000,
  })
    .then((client) => {
      let closing;
      const owner = {
        close: () => {
          closing ??= client.close();
          return closing;
        },
        grep: (request) => client.grep(request),
      };
      queryOwners.add(owner);
      return owner;
    })
    .catch((cause) => {
      if (cause instanceof SqliteQueryStartupCleanupError) {
        // The failed startup already attempted close. Retain that failure without an implicit retry.
        queryOwners.add({
          close: async () => {
            throw cause;
          },
        });
      }
      throw cause;
    });
  queryAcquisitions.add(pending);
  pending.then(
    () => queryAcquisitions.delete(pending),
    () => queryAcquisitions.delete(pending)
  );
  return pending;
};
const closeRuntime = () => {
  runtimeClose ??= runtime.retireProfile();
  return runtimeClose;
};
const closeServices = () => {
  servicesClose ??= services.close();
  return servicesClose;
};
const closeStore = () => {
  storeClose ??= store.close();
  return storeClose;
};
const closeSeed = () => {
  seedClose ??= seedOwner.close();
  return seedClose;
};
let operationFailure;
let operationFailed = false;
const cleanupFailures = [];
try {
  if (mode === 'seed') {
    await mkdir(profileDirectory, { recursive: true });
    for (const directory of [workspace, foreignWorkspace]) {
      await mkdir(path.dirname(path.join(directory, relativePath)), { recursive: true });
      await writeFile(path.join(directory, relativePath), content);
    }
  }
  store = await StateStore.open(profileDirectory, { home: fixture });
  if (mode === 'seed') {
    seedOwner = createNodeProfileDatabaseOwner({ getLocation: () => location });
    const db = await seedOwner.initialize();
    const model = (
      await db.query(
        "SELECT id, provider_id, capabilities FROM models WHERE capabilities->>'type' = 'embedding' ORDER BY id LIMIT 1"
      )
    ).rows[0];
    assert.ok(model && typeof model.id === 'string');
    const dimensions = model.capabilities.defaultDimension;
    assert.ok(Number.isSafeInteger(dimensions) && dimensions > 0);
    const collectionId = randomUUID();
    await db.query(
      'INSERT INTO roots(id,kind,display_name,path) VALUES ($1,$2,$3,$4),($5,$2,$6,$7)',
      [rootId, 'path', 'Captured root', workspace, foreignRootId, 'Foreign root', foreignWorkspace]
    );
    await db.query(
      'INSERT INTO embedding_sets(id,model_id,model_key,dimensions,distance,system_role) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        collectionId,
        model.id,
        `${model.provider_id}::${model.id}`,
        dimensions,
        'cosine',
        'workspace-index',
      ]
    );
    const records = [rootId, foreignRootId, null].map((id) => ({
      embeddingSetId: collectionId,
      fileId: randomUUID(),
      relativePath: id === null ? null : relativePath,
      rootId: id,
      sourcePath: id === null ? path.join(fixture, 'retained-import.ts') : null,
    }));
    for (const file of records) {
      await db.query(
        'INSERT INTO file_records(id,name,path,root_id,embedding_set_id,size,content,content_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          file.fileId,
          'Captured canonical source',
          file.relativePath ?? file.sourcePath,
          file.rootId,
          collectionId,
          Buffer.byteLength(content),
          content,
          captured.sourceHash,
        ]
      );
    }
    await writeFile(seedPath, JSON.stringify({ collectionId, modelId: model.id, records }));
    await writeFile(
      ledger,
      JSON.stringify({
        recentRootsList: '[]',
        rootsList: JSON.stringify([
          { addedAt: 1, path: workspace, rootId },
          { addedAt: 2, path: foreignWorkspace, rootId: foreignRootId },
        ]),
        [NATIVE_INDEX_SETTINGS_KEY]: JSON.stringify({
          state: {
            enabled: true,
            indexingPolicyPreset: 'balanced',
            managedCollectionId: collectionId,
            nativeIndexMode: 'TEXT',
            nativeLocalSelection: null,
            paused: false,
            worktreeRootIndexingOptInById: {},
          },
        }),
      })
    );
    await closeSeed();
    await closeStore();
    process.stdout.write(`${JSON.stringify({ electron: false, seeded: true })}\n`);
  } else {
    const seed = JSON.parse(await readFile(seedPath, 'utf8'));
    const joins = [];
    services = await openExistingNodeWorkspaceServices(
      {
        register: async (close) => {
          joins.push(close);
        },
        signal: shutdown.signal,
        store,
      },
      {
        disposeCommandSessionsForRoot: async () => 0,
        evictLspServersForRoot: async () => undefined,
        grants: { getItem: async (key) => JSON.parse(await readFile(ledger, 'utf8'))[key] ?? null },
        location,
        subscribe: async () => {
          throw new Error('This read fixture does not acquire subscriptions.');
        },
      }
    );
    const savedSettings = readNativeIndexSettings(
      JSON.parse(await readFile(ledger, 'utf8'))[NATIVE_INDEX_SETTINGS_KEY]
    );
    assert.equal(savedSettings.mode, 'TEXT');
    const savedIdentity = nativeIndexConfigurationIdentity(savedSettings);
    const authority = async () => {
      const roots = await services.readRoots();
      const saved = readNativeIndexSettings(
        JSON.parse(await readFile(ledger, 'utf8'))[NATIVE_INDEX_SETTINGS_KEY]
      );
      if (nativeIndexConfigurationIdentity(saved) !== savedIdentity) {
        throw new NativeAuthorityTransitionError('Captured native saved choice changed.');
      }
      return services.withCatalog(async (db) => {
        const collection = (
          await db.query('SELECT model_id FROM embedding_sets WHERE id = $1', [seed.collectionId])
        ).rows;
        assert.equal(collection.length, 1);
        assert.equal(collection[0].model_id, seed.modelId);
        const records = (
          await db.query(
            'SELECT id, root_id, path, embedding_set_id FROM file_records WHERE embedding_set_id = $1 ORDER BY id',
            [seed.collectionId]
          )
        ).rows;
        const live = new Set(roots.map((root) => root.rootId));
        return {
          fileBindings: records
            .filter((file) => file.root_id === null || live.has(file.root_id))
            .map((file) => ({
              embeddingSetId: file.embedding_set_id,
              fileId: file.id,
              profile: null,
              relativePath: file.root_id === null ? null : file.path,
              rootId: file.root_id,
              sourcePath: file.root_id === null ? file.path : null,
            })),
          rootIds: [...live],
          scopes: [
            ...[...live].map((id) => ({ kind: 'workspace', rootId: id })),
            { embeddingSetId: seed.collectionId, kind: 'collection' },
          ],
        };
      });
    };
    lease = await services.borrowRoot(rootId);
    const foreignLease = await services.borrowRoot(foreignRootId);
    assert.equal(lease, await services.borrowRoot(rootId));
    receipt.sameLease = true;
    const bytes = await lease.readFile(relativePath, Buffer.byteLength(content) + 1, context());
    assert.equal(bytes.status, 'ok');
    assert.equal(Buffer.from(bytes.content).toString(), content);
    runtime = createNativeIndexRuntime({
      closeQueries: joinQueries,
      createIndexOwner: async (authorized) => {
        ownerCount += 1;
        let acquired;
        let closing;
        return {
          close: () => {
            closing ??= (async () => {
              await (await acquired)?.close();
            })();
            return closing;
          },
          databasePath: dbPath,
          start: () => {
            acquired ??= openIndexer(
              { dbPath, embedding: { indexMode: 'text-only' }, ...authorized },
              deadlines
            ).then((writer) => {
              const search = writer.searchScopes.bind(writer);
              writer.searchScopes = async (request) => {
                readCount += 1;
                const result = await search(request);
                if (searchTail) {
                  const tail = searchTail;
                  searchTail = undefined;
                  pendingTails.add(tail);
                  tail.entered.resolve();
                  try {
                    await tail.release.promise;
                  } finally {
                    pendingTails.delete(tail);
                  }
                }
                return result;
              };
              return writer;
            });
            return acquired;
          },
        };
      },
      // Borrow the existing service; never call a profile or cold factory again.
      createProfileOwner: () => ({ acquire: async () => services, close: closeServices }),
      getAuthority: authority,
      getFileInvalidator: () => publication && ((file) => publication.invalidateFile(file)),
      installQueryTarget: () => undefined,
    });
    port = await runtime.acquire();
    const initialAuthority = runtime.captureAcknowledgedAuthority().readAuthority();
    publication = createNativeCanonicalPublication(port, initialAuthority.scopes);
    for (const scope of initialAuthority.scopes) {
      const files = initialAuthority.fileBindings.filter((file) =>
        scope.kind === 'workspace'
          ? file.rootId === scope.rootId
          : file.embeddingSetId === scope.embeddingSetId
      );
      const ticket = await publication.beginScan({
        requestId: `captured-${JSON.stringify(scope)}`,
        scope,
      });
      for (const file of files) {
        await publication.commitTextFile({
          file: { ...file, fileName: 'Captured canonical source' },
          payload: { content, fileId: file.fileId, providedChunks: captured.result.chunks },
          ticket,
        });
      }
      assert.equal(
        (
          await publication.finishScan({
            aborted: false,
            errors: [],
            files: files.map((file) => ({ ...file, contentHash: captured.sourceHash })),
            full: true,
            ticket,
            truncatedDirectories: [],
          })
        ).scanComplete,
        true
      );
    }
    for (const scope of initialAuthority.scopes) {
      assert.equal(await publication.reverifyScope(scope, null), true);
    }
    graph = {
      controller: new AbortController(),
      generation: 1,
      leases: new Map([
        [rootId, lease],
        [foreignRootId, foreignLease],
      ]),
      settings: savedSettings,
      watchFailures: new Map(),
    };
    const readAuthority = createNativeIndexReadAuthority({
      acquireRead: () => runtime.acquire(),
      assertCurrent: (current) => {
        assert.equal(current, graph);
        current.controller.signal.throwIfAborted();
      },
      authority,
      getGraph: () => graph,
      readiness: () => publication.getReadiness(),
      resolveProfile: async () => null,
      runtime,
      settingsReads: new Set(),
    });
    const capability = createNativeScopedSearchCapability({
      openQuery,
      rebuild: () => runtime.closeIndex(),
      withRead: readAuthority.withRead,
    });
    const text = createNodeNativeTextServices({
      withBorrow: (leases, operation, work) =>
        readAuthority.withRead(async (read) => {
          operation.signal.throwIfAborted();
          return work({
            capability: createNativeScopedSearchCapability({
              openQuery,
              rebuild: () => runtime.closeIndex(),
              withRead: async (callback) => callback(read),
            }),
            collectionId: savedSettings.managedCollectionId,
            leases,
            revalidate: async (operationContext) => {
              operationContext.signal.throwIfAborted();
              const current = await read.getAuthority();
              assert.equal(current.collectionId, savedSettings.managedCollectionId);
            },
          });
        }),
      workspace: services,
    });
    const request = {
      limit: 10,
      mode: 'bm25',
      rootIds: [rootId],
      text: 'projectToolOutputArtifactPage',
    };
    const result = await text.search(request, context());
    const selectedFile = seed.records.find((file) => file.rootId === rootId);
    assert.ok(selectedFile);
    assert.equal(result.hits.length, 2);
    assert.equal(result.scanLimited, false);
    for (const hit of result.hits) {
      const chunk = captured.result.chunks.find((item) => item.chunkIndex === hit.chunkIndex);
      assert.ok(chunk);
      assert.equal(hit.fileId, selectedFile.fileId);
      assert.equal(hit.rootId, rootId);
      assert.equal(hit.relativePath, relativePath);
      assert.equal(hit.embeddingSetId, seed.collectionId);
      assert.equal(hit.sourcePath, null);
      assert.match(hit.chunkId, /^[a-f0-9]{64}$/);
      assert.equal(hit.content, chunk.content);
      assert.equal(hit.contentHash, chunk.contentHash);
      assert.equal(hit.startLine, chunk.startLine);
      assert.equal(hit.endLine, chunk.endLine);
      assert.equal(hit.startOffset, chunk.startOffset);
      assert.equal(hit.endOffset, chunk.endOffset);
      assert.ok(Number.isFinite(hit.score));
    }
    receipt.exactProvenance = true;
    const before = readCount;
    await assert.rejects(text.search({ ...request, rootIds: [] }, context()));
    await assert.rejects(text.search({ ...request, rootIds: [rootId, rootId] }, context()));
    await assert.rejects(text.search({ ...request, rootIds: [randomUUID()] }, context()));
    assert.equal(readCount, before);
    const extraCollection = await text.search(
      { ...request, collectionId: seed.collectionId },
      context()
    );
    assert.deepEqual(extraCollection.hits, result.hits);
    assert.equal(
      (await text.search({ ...request, limit: 1 }, context())).hits[0].fileId,
      selectedFile.fileId
    );
    receipt.authorizedBeforeRanking = true;
    if (mode === 'stop') {
      searchTail = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      const tail = searchTail;
      const stopped = new AbortController();
      const reason = new Error('Exact per-run Stop');
      let settled = false;
      let published = false;
      const pending = text.search(request, {
        requestId: 'joined-native-text-stop',
        signal: stopped.signal,
      });
      pending.then(
        () => {
          settled = true;
          published = true;
        },
        () => {
          settled = true;
        }
      );
      await tail.entered.promise;
      stopped.abort(reason);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(store.lock.isReleased, false);
      assert.equal(
        children().some((child) => child.exitCode === null && child.signalCode === null),
        true
      );
      await access(path.join(profileDirectory, '.db-process.lock'));
      tail.release.resolve();
      await assert.rejects(pending, (cause) => cause === reason);
      assert.equal((await text.search(request, context())).hits.length, 2);
      searchTail = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      const retiringTail = searchTail;
      const finalRead = text.search(request, context());
      const rejectedRead = assert.rejects(finalRead, NativeReadAuthorityRetiredError);
      await retiringTail.entered.promise;
      let retirementSettled = false;
      const retiring = runtime.retireReads().then(() => {
        retirementSettled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(retirementSettled, false);
      retiringTail.release.resolve();
      await rejectedRead;
      await retiring;
      await assert.rejects(text.search(request, context()));
      assert.equal(published, false);
      receipt.noLatePublication = true;
      receipt.stopJoined = true;
    } else {
      if (mode === 'query') {
        const grep = await capability.grep({
          caseSensitive: true,
          isRegex: false,
          limit: 100,
          pattern: 'projectToolOutputArtifactPage',
          rootIds: [rootId],
        });
        assert.deepEqual(
          grep.hits.map((hit) => hit.chunkId).sort(),
          result.hits.map((hit) => hit.chunkId).sort()
        );
        const cleanupCause = new Error('Retained reader cleanup failure');
        const failedCleanup = createNativeScopedSearchCapability({
          openQuery: async () => {
            const reader = await openQuery();
            return {
              close: async () => {
                await reader.close();
                throw cleanupCause;
              },
              grep: reader.grep,
            };
          },
          rebuild: () => runtime.closeIndex(),
          withRead: readAuthority.withRead,
        });
        await assert.rejects(
          failedCleanup.grep({
            caseSensitive: true,
            isRegex: false,
            limit: 100,
            pattern: 'projectToolOutputArtifactPage',
            rootIds: [rootId],
          }),
          (cause) => cause === cleanupCause
        );
        receipt.cleanupFailureVisible = true;
      }
      publication.invalidateScope({ kind: 'workspace', rootId });
      assert.equal((await text.search(request, context())).scanLimited, true);
      receipt.partialCoverage = true;
      assert.equal(await publication.reverifyScope({ kind: 'workspace', rootId }, null), false);
      const initialOwners = ownerCount;
      await runtime.closeIndex();
      await runtime.resume();
      port = await runtime.acquire();
      publication = createNativeCanonicalPublication(port, initialAuthority.scopes);
      const reopened = await text.search(request, context());
      assert.deepEqual(reopened.hits, result.hits);
      assert.equal(reopened.storeId, result.storeId);
      assert.equal(reopened.scanLimited, true);
      assert.equal(ownerCount, initialOwners + 1);
      receipt.reopened = true;
      const originalLedger = await readFile(ledger, 'utf8');
      const changed = JSON.parse(originalLedger);
      const settings = JSON.parse(changed[NATIVE_INDEX_SETTINGS_KEY]);
      settings.state.managedCollectionId = randomUUID();
      changed[NATIVE_INDEX_SETTINGS_KEY] = JSON.stringify(settings);
      await writeFile(ledger, JSON.stringify(changed));
      await assert.rejects(text.search(request, context()), NativeAuthorityTransitionError);
      await writeFile(ledger, originalLedger);
      receipt.savedChoiceDriftRefused = true;
      changed.rootsList = JSON.stringify([
        { addedAt: 2, path: foreignWorkspace, rootId: foreignRootId },
      ]);
      changed[NATIVE_INDEX_SETTINGS_KEY] = JSON.parse(originalLedger)[NATIVE_INDEX_SETTINGS_KEY];
      await writeFile(ledger, JSON.stringify(changed));
      const readsBeforeRevoke = readCount;
      await assert.rejects(text.search(request, context()));
      assert.equal(readCount, readsBeforeRevoke);
      assert.equal(lease.signal.aborted, true);
      receipt.revokedRefused = true;
    }
    await closeRuntime();
    for (const join of joins) {
      await join();
    }
    assert.equal(store.lock.isReleased, false);
    assert.equal(
      children().some((child) => child.exitCode === null && child.signalCode === null),
      false
    );
    await closeStore();
    assert.equal(RootLock.inspect(profileDirectory).owner.released, true);
    receipt.joined = true;
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }
} catch (cause) {
  operationFailure = cause;
  operationFailed = true;
} finally {
  searchTail?.release.resolve();
  for (const tail of pendingTails) {
    tail.release.resolve();
  }
  for (const close of [
    runtime && closeRuntime,
    !runtime && services && closeServices,
    seedOwner && closeSeed,
  ]) {
    if (!close) {
      continue;
    }
    try {
      await close();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
  // Release Root only when physical owned runtime/profile joins succeeded.
  if (cleanupFailures.length === 0 && store) {
    try {
      await closeStore();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
}
if (operationFailed || cleanupFailures.length) {
  throw new AggregateError(
    [...(operationFailed ? [operationFailure] : []), ...cleanupFailures],
    'Native TEXT fixture operation/cleanup failed.',
    { cause: operationFailure }
  );
}
