import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listProviderEmbeddingModels } from '@brainstrike/assistant-contract';
import {
  createNativeScopedSearchCapability,
  createNodeNativeTextServices,
  NativeAuthorityTransitionError,
  NativeIndexSetupRequiredError,
} from '@brainstrike/assistant-service/node-native-text-services';
import {
  joinProfileDirectory,
  openExistingNodeWorkspaceServices,
} from '@brainstrike/assistant-service/node-workspace-services';
import { createNativeCanonicalPublication } from '@brainstrike/canonical-ingestion';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import {
  SqliteQueryClient,
  SqliteQueryStartupCleanupError,
  SqliteRuntimeRefusedError,
  spawnQueryProcess,
} from '@brainstrike/sqlite-query';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { sendFixtureResult } from './fixture-result.mjs';

const [mode, fixture, capturedPath, ownerBundles] = process.argv.slice(2);
assert.ok(mode && fixture && capturedPath && ownerBundles);
assert.equal(process.versions.electron, undefined);
const original = (name) => import(pathToFileURL(path.join(ownerBundles, `${name}.mjs`)).href);
const { createDesktopProfileRuntime } = await original('desktop-profile-runtime');
const { createNativeIndexRuntime } = await original('native-index-runtime');
const { readNativeIndexSettings, NATIVE_INDEX_SETTINGS_KEY, nativeIndexConfigurationIdentity } =
  await original('native-index-settings');
for (const [name, exportName, expectedClass] of [
  ['native-authority-transition', 'NativeAuthorityTransitionError', NativeAuthorityTransitionError],
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
let seedIndexer;
let seedIndexerClose;
let runtime;
let runtimeClose;
let servicesClose;
let storeClose;
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
    spawn: () => spawnQueryProcess({ executable: process.execPath }),
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
const closeSeedIndexer = () => {
  seedIndexerClose ??= seedIndexer.close();
  return seedIndexerClose;
};
const closeStore = () => {
  storeClose ??= store.close();
  return storeClose;
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
  store = await StateStore.open(profileDirectory, {
    home: fixture,
    ...(mode === 'seed'
      ? {
          startup: {
            acquire: async (acquired) => {
              seedIndexer = await openIndexer(
                {
                  dbPath: path.join(profileDirectory, 'seed-state-index.sqlite'),
                  embedding: { indexMode: 'text-only' },
                  rootIds: [],
                  stateProjection: {
                    mode: 'dev',
                    module: new URL(
                      '../../../../indexer/__tests__/fixtures/state-schema.mjs',
                      import.meta.url
                    ).href,
                  },
                  stateRoot: await realpath(acquired.root),
                },
                deadlines
              );
              return createStateStoreIndexer(seedIndexer);
            },
            close: async () => {
              if (seedIndexer) {
                await closeSeedIndexer();
              }
            },
          },
        }
      : {}),
  });
  if (mode === 'seed') {
    const model = listProviderEmbeddingModels('local').find(
      (entry) => entry.id === 'Xenova/all-MiniLM-L6-v2'
    );
    assert.ok(model);
    const collectionId = randomUUID();
    await store.collections({
      collection: {
        createdAt: new Date().toISOString(),
        dimensions: model.defaultDimension,
        distance: 'cosine',
        id: collectionId,
        modelId: model.id,
        modelKey: `local::${model.id}`,
        systemRole: 'workspace-index',
      },
      operation: 'create',
    });
    for (const [id, directory, displayName] of [
      [rootId, workspace, 'Captured root'],
      [foreignRootId, foreignWorkspace, 'Foreign root'],
    ]) {
      const registered = await store.workspaceRoots({
        operation: 'register',
        root: { displayName, path: directory, preferredId: id },
      });
      assert.ok(registered.roots.some((root) => root.id === id));
    }
    const records = [];
    for (const id of [rootId, foreignRootId, null]) {
      const sourcePath = id === null ? path.join(fixture, 'retained-import.ts') : relativePath;
      const files = [
        {
          content,
          contentHash: captured.sourceHash,
          fileName: 'Captured canonical source',
          path: sourcePath,
          stat: { mtimeMs: null, size: Buffer.byteLength(content) },
        },
      ];
      const prepared = await store.sourceCatalog(
        id === null
          ? { embeddingSetId: collectionId, files, operation: 'import' }
          : { embeddingSetId: collectionId, files, operation: 'prepare', rootId: id }
      );
      assert.equal(prepared.files.length, 1);
      const file = prepared.files[0];
      assert.equal(file.rootId, id);
      records.push({
        embeddingSetId: file.embeddingSetId,
        fileId: file.fileId,
        relativePath: id === null ? null : file.path,
        rootId: file.rootId,
        sourcePath: id === null ? file.path : null,
      });
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
    await closeSeedIndexer();
    await closeStore();
    await sendFixtureResult({ electron: false, seeded: true });
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
      return services.withCatalog(async (catalog) => {
        assert.equal(catalog, store);
        const collection = (await catalog.collections({ id: seed.collectionId, operation: 'get' }))
          .collections;
        assert.equal(collection.length, 1);
        assert.equal(collection[0].modelId, seed.modelId);
        const records = (
          await catalog.sourceCatalog({ embeddingSetId: seed.collectionId, operation: 'inventory' })
        ).files;
        const live = new Set(roots.map((root) => root.rootId));
        return {
          fileBindings: records
            .filter((file) => file.rootId === null || live.has(file.rootId))
            .map((file) => ({
              embeddingSetId: file.embeddingSetId,
              fileId: file.fileId,
              profile: null,
              relativePath: file.rootId === null ? null : file.path,
              rootId: file.rootId,
              sourcePath: file.rootId === null ? file.path : null,
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
      getAuthority: authority,
      getFileInvalidator: () => publication && ((file) => publication.invalidateFile(file)),
      installQueryTarget: () => undefined,
      // Borrow the existing service; never call a profile or cold factory again.
      profile: createDesktopProfileRuntime(() => ({
        acquire: async () => services,
        close: closeServices,
      })),
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
    // This fixture owns the static source graph; the product runtime still owns
    // the actual writer borrow and retirement fence throughout every service call.
    const readAuthority = {
      withRead: (work) =>
        runtime.withRead(
          () => runtime.acquire(),
          (captured) =>
            work({
              getAuthority: async () => {
                graph.controller.signal.throwIfAborted();
                for (const lease of graph.leases.values()) {
                  lease.signal.throwIfAborted();
                }
                const acknowledged = captured.readAuthority();
                const current = await authority();
                captured.readAuthority();
                graph.controller.signal.throwIfAborted();
                for (const lease of graph.leases.values()) {
                  lease.signal.throwIfAborted();
                }
                return {
                  bindings: acknowledged.fileBindings,
                  collectionId: savedSettings.managedCollectionId,
                  generation: graph.generation,
                  profile: null,
                  queryPlan: undefined,
                  readiness: publication.getReadiness(),
                  rootIds: current.rootIds,
                };
              },
              port: captured.port,
            })
        ),
    };
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
      assert.deepEqual(RootLock.inspect(profileDirectory).owner, store.lock.owner);
      await assert.rejects(access(path.join(profileDirectory, '.db-process.lock')), {
        code: 'ENOENT',
      });
      tail.release.resolve();
      await assert.rejects(pending, (cause) => cause === reason);
      assert.equal((await text.search(request, context())).hits.length, 2);
      searchTail = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      const retiringTail = searchTail;
      const finalRead = text.search(request, context());
      const rejectedRead = assert.rejects(finalRead, NativeAuthorityTransitionError);
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
      } else if (mode === 'query-refused') {
        // A runtime whose SQLite cannot enforce the sandbox heap limit is refused at open
        // (docs/archive/agent-contract-history/agent-self-query/sqlite-index-foundation.md);
        // plain Node/CLI support is BST-1941's.
        await assert.rejects(
          capability.grep({
            caseSensitive: true,
            isRegex: false,
            limit: 100,
            pattern: 'projectToolOutputArtifactPage',
            rootIds: [rootId],
          }),
          (cause) => cause instanceof SqliteRuntimeRefusedError
        );
        receipt.runtimeRefused = true;
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
    await sendFixtureResult(receipt);
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
    seedIndexer && closeSeedIndexer,
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
