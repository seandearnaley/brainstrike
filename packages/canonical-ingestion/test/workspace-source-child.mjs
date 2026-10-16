// Controlled catalog/publication ports; real pinned native root, Parcel watcher,
// built canonical parser/source/coalescer and a physically joined Node child.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CanonicalWorkspaceIngestionRuntime,
  CanonicalWorkspaceSource,
  createNodeChunker,
} from '@brainstrike/canonical-ingestion';

const recorded = JSON.parse(
  await readFile(
    new URL(import.meta.resolve('@brainstrike/test-utils/fixtures/canonical-provided-chunks.json')),
    'utf8'
  )
);
const hash = (content) => createHash('sha256').update(content, 'utf8').digest('hex');

async function collectDiscovery(iterator) {
  const batches = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return { batches, completion: next.value };
    }
    batches.push(next.value);
  }
}

function mailbox(emitter) {
  const queued = [];
  const waiting = new Set();
  emitter.on('message', (message) => {
    const waiter = [...waiting].find((candidate) => candidate.predicate(message));
    if (waiter) {
      waiting.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queued.push(message);
    }
  });
  return (predicate) => {
    const index = queued.findIndex(predicate);
    if (index !== -1) {
      return Promise.resolve(queued.splice(index, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: undefined };
      waiter.timer = setTimeout(() => {
        waiting.delete(waiter);
        reject(new Error(`Node source proof message did not arrive for ${predicate.toString()}.`));
      }, 20_000);
      waiting.add(waiter);
    });
  };
}

async function runParent() {
  const { SecureRoot } = await import('@brainstrike/secure-fs-native');
  const { startJoinedParcelWatch } = await import('@brainstrike/file-system/native-watch');
  const directory = await mkdtemp(path.join(tmpdir(), 'canonical-source-child-'));
  const filename = path.join(directory, recorded.relativePath);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, recorded.content);
  await writeFile(path.join(directory, 'survivor.ts'), 'export const survivor = 1;\n');
  await mkdir(path.join(directory, '.venv'));
  await writeFile(path.join(directory, '.venv', 'ignored.py'), 'secret = 1');
  const root = new SecureRoot(directory);
  const child = fork(fileURLToPath(import.meta.url), ['child', root.canonicalPath], {
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const next = mailbox(child);
  let diagnostic = '';
  child.stderr.on('data', (chunk) => {
    diagnostic += chunk;
  });
  child.stdout.on('data', (chunk) => {
    diagnostic += chunk;
  });
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );
  const rootId = 'controlled-mounted-root';
  const reads = new Map();
  const listings = [];
  let stopWatch;
  let watchStarts = 0;
  let watchStops = 0;
  let holdReads = false;
  let releaseRead = () => {};
  let notifyRead = () => {};
  const readAdmitted = new Promise((resolve) => {
    notifyRead = resolve;
  });
  let heldRead;
  let truncate = false;
  const operations = new Set();
  child.on('message', (message) => {
    if (
      ['receipt', 'held-read', 'runtime-error', 'ready', 'command-result'].includes(message.kind)
    ) {
      diagnostic += `${JSON.stringify(message)}\n`;
    }
  });
  const readBounded = async (args) => {
    assert.ok(Number.isSafeInteger(args.maxBytes) && args.maxBytes > 0 && args.maxBytes <= 100_000);
    reads.set(args.relativePath, (reads.get(args.relativePath) ?? 0) + 1);
    // Start the actual bounded native read before holding its acknowledgement.
    const result = await root.readFileAsync(args.relativePath, args.maxBytes);
    if (holdReads) {
      heldRead = new Promise((resolve) => {
        releaseRead = resolve;
      });
      notifyRead(args.relativePath);
      await heldRead;
    }
    return result;
  };
  child.on('message', (message) => {
    if (message.kind !== 'operation') {
      return;
    }
    const operation = (async () => {
      const { method, args } = message;
      if (method === 'list') {
        assert.ok(
          Number.isSafeInteger(args.maxEntries) && args.maxEntries > 0 && args.maxEntries <= 10_000
        );
        listings.push(args.relativePath);
        return root.listDirAsync(args.relativePath, truncate ? 1 : args.maxEntries);
      }
      if (method === 'read') {
        return readBounded(args);
      }
      if (method === 'subscribe') {
        assert.equal(stopWatch, undefined);
        watchStarts += 1;
        stopWatch = await startJoinedParcelWatch(
          {
            kind: 'directory',
            name: path.basename(directory),
            path: root.canonicalPath,
            platform: 'electron',
            rootId,
          },
          (changes, metadata) => child.send({ changes, kind: 'watch', metadata }),
          { onHealth: (health) => child.send({ health, kind: 'health' }) }
        );
        return null;
      }
      if (method === 'unsubscribe') {
        assert.ok(stopWatch);
        await stopWatch();
        stopWatch = undefined;
        watchStops += 1;
        return null;
      }
      if (method === 'retire') {
        return null;
      }
      assert.fail(`Unexpected fixture operation ${method}`);
    })();
    operations.add(operation);
    operation
      .then(
        (value) => child.send({ id: message.id, kind: 'response', value }),
        (error) => child.send({ error: String(error), id: message.id, kind: 'response' })
      )
      .finally(() => operations.delete(operation));
  });
  const command = async (action, args = {}) => {
    const id = randomUUID();
    child.send({ action, args, id, kind: 'command' });
    const result = await next((message) => message.kind === 'command-result' && message.id === id);
    if (result.error) {
      throw new Error(result.error);
    }
    return result.value;
  };
  try {
    await next((message) => message.kind === 'ready');
    const initial = await next(
      (message) => message.kind === 'receipt' && message.paths?.includes(recorded.relativePath)
    );
    assert.equal(initial.canonicalParity, true);
    assert.equal(initial.scanComplete, true);
    assert.deepEqual(initial.paths.sort(), [recorded.relativePath, 'survivor.ts'].sort());
    assert.equal(
      listings.some((value) => value.includes('.venv')),
      false
    );
    const survivorReads = reads.get('survivor.ts');
    const changed = `${recorded.content}\nexport const childProofChange = 1;\n`;
    await writeFile(filename, changed);
    const update = await next(
      (message) =>
        message.kind === 'receipt' && message.hashes?.[recorded.relativePath] === hash(changed)
    );
    assert.equal(update.scanComplete, true);
    assert.equal(reads.get('survivor.ts'), survivorReads);
    await rm(filename);
    const deleted = await next(
      (message) => message.kind === 'receipt' && !message.paths?.includes(recorded.relativePath)
    );
    assert.equal(deleted.scanComplete, true);
    assert.deepEqual(deleted.paths, ['survivor.ts']);
    assert.equal(deleted.removalOrder.join(','), 'native,catalog');
    holdReads = true;
    await writeFile(path.join(directory, 'held.ts'), 'export const held = 1;\n');
    await readAdmitted;
    let closed = false;
    const closing = command('close').then(() => {
      closed = true;
    });
    // This command runs while close is awaiting the admitted physical read.
    await command('barrier');
    assert.equal(closed, false);
    assert.equal(watchStops, 0);
    holdReads = false;
    releaseRead();
    await closing;
    assert.equal(watchStarts, 1);
    assert.equal(watchStops, 1);
    assert.equal(root.readFile('survivor.ts', 100_000).status, 'ok');
    await symlink(path.join(directory, 'survivor.ts'), path.join(directory, 'linked.ts'));
    await writeFile(path.join(directory, 'nul.ts'), 'x\u0000y');
    assert.deepEqual(await command('gates'), { binaryRefused: true, symlinkRefused: true });
    await writeFile(path.join(directory, '.gitignore'), 'generated/\nnested/*.ts\n');
    await mkdir(path.join(directory, 'generated'));
    await writeFile(path.join(directory, 'generated', 'copy.ts'), 'export const copy = 1;');
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'nested', '.gitignore'), '!keep.ts\n');
    await writeFile(path.join(directory, 'nested', 'drop.ts'), 'export const drop = 1;');
    await writeFile(path.join(directory, 'nested', 'keep.ts'), 'export const keep = 1;');
    const ignore = await command('ignore');
    assert.equal(ignore.paths.includes('generated/copy.ts'), false);
    assert.equal(ignore.paths.includes('nested/drop.ts'), false);
    assert.equal(ignore.paths.includes('nested/keep.ts'), true);
    assert.equal(listings.includes('generated'), false);
    assert.ok(reads.get('.gitignore') > 0);
    assert.ok(reads.get('nested/.gitignore') > 0);
    truncate = true;
    assert.deepEqual(await command('truncated'), {
      absentRowsRetained: true,
      nativeTruncation: true,
    });
    await command('exit');
    const exit = await exited;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(child.exitCode, 0);
    await Promise.all(operations);
    process.stdout.write(
      `${JSON.stringify({
        builtChildEntry: true,
        canonicalParity: true,
        changedAndDeleted: true,
        childExitCode: exit.code,
        childPid: child.pid,
        heldReadJoined: true,
        ignorePrunedBeforeListing: true,
        nativeTruncation: true,
        nestedIgnoreNegation: true,
        pinnedRootSurvivedBorrow: true,
        rootIgnorePrunedBeforeListing: true,
        symlinkAndBinaryRefused: true,
        unchangedSurvivorNotRead: true,
        watchJoined: true,
      })}\n`
    );
  } catch (error) {
    throw new Error(`${String(error)}\n${diagnostic}`, { cause: error });
  } finally {
    holdReads = false;
    releaseRead();
    if (stopWatch) {
      await stopWatch();
    }
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
    await Promise.allSettled(operations);
    root.close();
    await rm(directory, { force: true, recursive: true });
  }
}

async function runChild() {
  assert.equal(globalThis.window, undefined);
  assert.equal(globalThis.self, undefined);
  const responses = new Map();
  const rpc = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      responses.set(id, { reject, resolve });
      process.send({ args, id, kind: 'operation', method });
    });
  const canonicalPath = process.argv[3];
  const rootId = 'controlled-mounted-root';
  const scope = { kind: 'workspace', rootId };
  const rows = new Map();
  const native = new Map();
  const removalOrder = [];
  let generation = 0;
  let onBatch;
  let onHealth;
  let canonicalParity = false;
  const lease = () => ({
    canonicalPath,
    generation: randomUUID(),
    listDir: (relativePath, maxEntries) => rpc('list', { maxEntries, relativePath }),
    readFile: (relativePath, maxBytes) => rpc('read', { maxBytes, relativePath }),
    retire: () => rpc('retire'),
    rootId,
    signal: new AbortController().signal,
    subscribe: async (batch, _signal, health) => {
      onBatch = batch;
      onHealth = health;
      await rpc('subscribe');
      return {
        close: async () => {
          await rpc('unsubscribe');
          onBatch = undefined;
          onHealth = undefined;
        },
      };
    },
  });
  const inventory = {
    loadFiles: async () =>
      [...rows.values()].map(
        ({ content: _content, contentHash: _hash, chunksProcessed: _processed, ...file }) => file
      ),
    readRetained: async () => assert.fail('Workspace scan used retained reads.'),
  };
  const coverage = (files) => {
    const missing = files.filter((file) => !native.has(file.fileId));
    const changed = files.filter(
      (file) => native.has(file.fileId) && native.get(file.fileId).contentHash !== file.contentHash
    );
    const unexpected = [...native.values()].filter(
      (file) => !files.some((expected) => expected.fileId === file.fileId)
    );
    return {
      changed,
      complete: missing.length + changed.length + unexpected.length === 0,
      missing,
      storeId: 'controlled-publication',
      unexpected,
    };
  };
  const runtime = new CanonicalWorkspaceIngestionRuntime({
    catalog: {
      applyManagedCacheBatch: async (request) => {
        for (const file of request.files) {
          rows.set(file.fileId, {
            ...rows.get(file.fileId),
            ...file,
            chunksProcessed: false,
            stat: { ...file.stat, mtimeMs: Math.floor(file.stat.mtimeMs) },
          });
        }
      },
      completeFiles: async (request) => {
        for (const file of request.files) {
          assert.ok(native.has(file.fileId));
          rows.get(file.fileId).chunksProcessed = true;
        }
      },
      loadAuthorizedBatch: async (request) =>
        request.files.map((file) => {
          const row = rows.get(file.fileId);
          assert.ok(row);
          return row;
        }),
      prepareManagedSourcesBatch: async (request) =>
        request.files.map((file) => {
          assert.equal(Object.hasOwn(file, 'fileId'), false);
          assert.equal(file.contentHash, hash(file.content));
          const fileId =
            file.relativePath === recorded.relativePath ? recorded.fileId : randomUUID();
          const row = {
            ...file,
            chunksProcessed: false,
            embeddingSetId: 'controlled-PG-managed-set',
            fileId,
            stat: { ...file.stat, mtimeMs: Math.floor(file.stat.mtimeMs) },
          };
          rows.set(fileId, row);
          const { content: _content, chunksProcessed: _processed, stat: _stat, ...binding } = row;
          return binding;
        }),
      removeFiles: async (request) => {
        for (const file of request.files) {
          assert.equal(native.has(file.fileId), false);
          rows.delete(file.fileId);
          removalOrder.push('catalog');
        }
      },
      resolveProfile: async () => assert.fail('TEXT resolved inference.'),
    },
    chunker: createNodeChunker({ parser: 'oxc' }),
    managedCollectionId: 'controlled-PG-managed-set',
    onError: (operation, error) => {
      process.stderr.write(`${operation}: ${String(error)}\n`);
      process.send({ error: String(error), kind: 'runtime-error', operation });
    },
    onReceipt: (receipt) =>
      process.send({
        canonicalParity,
        hashes: Object.fromEntries(
          [...rows.values()].map((file) => [file.relativePath, file.contentHash])
        ),
        kind: 'receipt',
        paths: [...rows.values()].map((file) => file.relativePath),
        removalOrder,
        scanComplete: receipt.scanComplete,
      }),
    onWatchHealth: () => {},
    publication: {
      abortScan: async () => {},
      beginScan: async (request) => ({
        ...request,
        generation: ++generation,
        storeId: 'controlled-publication',
      }),
      commitTextFile: async (request) => {
        const row = rows.get(request.file.fileId);
        assert.ok(row);
        assert.equal(request.payload.content, row.content);
        assert.equal(hash(request.payload.content), row.contentHash);
        if (row.content === recorded.content) {
          assert.deepEqual(request.payload.providedChunks, recorded.result.chunks);
          assert.equal(request.payload.syntax.symbols[0].fileRecordId, recorded.fileId);
          canonicalParity = true;
        }
        native.set(request.file.fileId, { ...request.file, contentHash: row.contentHash });
      },
      finishScan: async (request) => {
        const scanComplete =
          request.full &&
          !request.aborted &&
          request.errors.length === 0 &&
          request.truncatedDirectories.length === 0 &&
          coverage(request.files).complete;
        return {
          reason: scanComplete ? 'complete' : 'aborted',
          scanComplete,
          ticket: request.ticket,
        };
      },
      removeFile: async (request) => {
        native.delete(request.file.fileId);
        removalOrder.push('native');
      },
      verifyManifest: async (request) => coverage(request.files),
    },
    request: {
      batchSize: 64,
      chunkingOptions: { maxTokens: 256, strategy: 'auto', tokenTrueSizing: true },
      maxFileBytes: 100_000,
    },
    source: { indexingPolicyPreset: 'balanced', inventory, lease: lease() },
  });
  const request = {
    batchSize: 64,
    chunkingOptions: { strategy: 'auto' },
    maxFileBytes: 100_000,
    requestId: 'direct-discovery',
    scope,
  };
  const context = { requestId: request.requestId, signal: new AbortController().signal };
  const proveGates = async (source, iterator) => {
    const next = await iterator.next();
    assert.equal(next.done, false);
    const entries = [...next.value.files, ...next.value.discovered];
    const linked = entries.find((file) => file.relativePath === 'linked.ts');
    const binary = entries.find((file) => file.relativePath === 'nul.ts');
    assert.ok(linked && binary);
    await assert.rejects(source.read(linked, 100_000, context), /symbolic link/);
    await assert.rejects(source.read(binary, 100_000, context));
    return { binaryRefused: true, symlinkRefused: true };
  };
  process.on('message', (message) => {
    if (message.kind === 'response') {
      const pending = responses.get(message.id);
      assert.ok(pending);
      responses.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.value);
      }
    } else if (message.kind === 'watch') {
      onBatch?.(message.changes, message.metadata);
    } else if (message.kind === 'health') {
      onHealth?.(message.health);
    } else if (message.kind === 'command') {
      (async () => {
        if (message.action === 'close') {
          await runtime.close();
          return null;
        }
        if (message.action === 'barrier') {
          return null;
        }
        if (message.action === 'exit') {
          assert.equal(responses.size, 0);
          return null;
        }
        const source = new CanonicalWorkspaceSource({
          indexingPolicyPreset: 'balanced',
          inventory,
          lease: lease(),
        });
        try {
          const iterator = source.discover(request, context);
          if (message.action === 'gates') {
            return await proveGates(source, iterator);
          }
          const { batches, completion } = await collectDiscovery(iterator);
          if (message.action === 'ignore') {
            return {
              paths: batches
                .flatMap((batch) => [...batch.files, ...batch.discovered])
                .map((file) => file.relativePath),
            };
          }
          assert.equal(message.action, 'truncated');
          assert.ok(completion.truncatedDirectories.length > 0);
          assert.equal(batches.flatMap((batch) => batch.removed).length, 0);
          return { absentRowsRetained: true, nativeTruncation: true };
        } finally {
          await source.close();
        }
      })().then(
        (value) => {
          process.send({ id: message.id, kind: 'command-result', value }, () => {
            if (message.action === 'exit') {
              process.disconnect();
            }
          });
        },
        (error) => process.send({ error: String(error), id: message.id, kind: 'command-result' })
      );
    }
  });
  await runtime.start();
  process.send({ kind: 'ready' });
}

if (process.argv[2] === 'child') {
  await runChild();
} else {
  await runParent();
}
