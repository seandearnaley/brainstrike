import { Worker } from 'node:worker_threads';
import { Schema } from 'effect';
import {
  commitResultSchema,
  decoder,
  fault,
  IndexerError,
  type IndexerInfo,
  identityStateSchema,
  infoSchema,
  optionsSchema,
  requestSchema,
  scopedRemoveSchema,
  stateCountsSchema,
  stateHealthSchema,
  stateMessageHitSchema,
  stateMessagePlanSchema,
  stateMessageUpsertResultSchema,
  stateObservationHitSchema,
  stateObservationPlanSchema,
  stateSearchCoverageResultSchema,
  stateSearchHitSchema,
  stateSearchPendingRowSchema,
  stateSearchSimilarHitSchema,
  stateSearchVectorsResultSchema,
  stateStatsSchema,
} from './contracts.js';
import { assertCoverageAuthorityBound, coverageAuthoritySchema } from './coverage-authority.js';
import { openDesktopIndexReader } from './desktop-index-connection.js';
import { readScopedIdentity } from './index-metadata.js';
import { promptVectorReplySchema } from './prompt-vector-contract.js';
import { RpcClient } from './rpc-client.js';
import { IndexReader } from './store.js';

export interface IndexerProcessEndpoint {
  finish(): void;
  onDisconnect?(listener: () => void): void;
  onMessage(listener: (message: unknown) => void): void;
  send(value: object): void;
}
export async function runIndexerProcess(
  input: unknown,
  endpoint: IndexerProcessEndpoint
): Promise<void> {
  const send = (value: object): void => endpoint.send(value);
  let reader: IndexReader | undefined;
  let worker: Worker | undefined;
  let closing = false;
  let closePromise: Promise<boolean> | undefined;
  try {
    const options = decoder(optionsSchema)(input);
    worker = new Worker(new URL('./writer-worker.js', import.meta.url), { workerData: options });
    const writer = worker;
    const client = new RpcClient(
      (message) => writer.postMessage(message),
      () => {
        void writer.terminate();
      }
    );
    const exited = new Promise<void>((resolve) => {
      writer.once('exit', () => resolve());
    });
    writer.on('message', (message: unknown) => client.receive(message));
    writer.on('error', (error) => client.fail(error));
    writer.on('exit', (code) => {
      client.fail(new IndexerError('writer-exited', `Indexer writer exited (${code}).`));
    });
    const close = (): Promise<boolean> => {
      closePromise ??= (async () => {
        closing = true;
        const failures: unknown[] = [];
        try {
          reader?.db.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          if (reader) {
            await client.call('close', null, decoder(Schema.Boolean));
          } else {
            // Startup owns only this writer. Join its teardown before reporting
            // an early Close; there is no ready reader or admitted request yet.
            await writer.terminate();
          }
        } catch (error) {
          failures.push(error);
        }
        await exited;
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Indexer close failed.');
        }
        return true;
      })();
      return closePromise;
    };
    endpoint.onDisconnect?.(() => {
      close().catch((error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
        );
        process.exitCode = 1;
      });
    });
    let receive: ((message: unknown) => void) | undefined;
    // BST-1977: the parent may close while this process awaits its writer.
    // Register once before that await so an EventEmitter cannot drop Close.
    endpoint.onMessage((message: unknown) => {
      if (receive) {
        receive(message);
        return;
      }
      let id: number | undefined;
      try {
        const request = decoder(requestSchema)(message);
        id = request.id;
        if (request.op !== 'close') {
          throw new IndexerError('indexer-not-ready', 'Indexer is still starting.');
        }
        decoder(Schema.Null)(request.payload);
        close().then(
          (value) => {
            send({ id: request.id, kind: 'response', ok: true, value });
            endpoint.finish();
          },
          (error: unknown) => {
            send({ error: fault(error), id: request.id, kind: 'response', ok: false });
            endpoint.finish();
          }
        );
      } catch (error) {
        send(
          id === undefined
            ? { error: fault(error), kind: 'startup-error' }
            : { error: fault(error), id, kind: 'response', ok: false }
        );
      }
    });
    const info = decoder(infoSchema)(await client.ready);
    if (closing) {
      await close();
      return;
    }
    reader = new IndexReader(options, openDesktopIndexReader(options));
    const connection = reader;
    const nativeInfo: IndexerInfo = {
      ...info,
      readerQueryOnly: decoder(Schema.Int)(connection.db.pragma('query_only', { simple: true })),
    };
    receive = (message: unknown) => {
      let id: number | undefined;
      try {
        const request = decoder(requestSchema)(message);
        id = request.id;
        if (closing && request.op !== 'close') {
          throw new IndexerError('indexer-closed', 'Indexer is closing.');
        }
        if (request.op !== 'close') {
          client.assertActive();
        }
        let work: unknown | Promise<unknown>;
        switch (request.op) {
          case 'state-observation-prepare':
            work = client.call(request.op, request.payload, decoder(stateObservationPlanSchema));
            break;
          case 'state-observation-upsert':
            work = client.call(request.op, request.payload, decoder(Schema.Array(Schema.String)));
            break;
          case 'state-observation-query':
            work = client.call(
              request.op,
              request.payload,
              decoder(Schema.Array(stateObservationHitSchema))
            );
            break;
          case 'state-observation-purge':
            work = client.call(request.op, request.payload, decoder(Schema.Boolean));
            break;
          case 'coverage-authority':
            decoder(Schema.Null)(request.payload);
            work = connection.db.transaction(() =>
              decoder(coverageAuthoritySchema)({
                ...readScopedIdentity(connection.db, connection.scoped.authority.revision),
                dbPath: options.dbPath,
                fileBindings: [...connection.scoped.authority.files.values()],
                rootIds: options.rootIds,
                scopes: options.scopes ?? [],
              })
            )();
            assertCoverageAuthorityBound(work);
            break;
          case 'state-message-prepare':
            work = client.call(request.op, request.payload, decoder(stateMessagePlanSchema));
            break;
          case 'state-message-upsert':
            work = client.call(
              request.op,
              request.payload,
              decoder(stateMessageUpsertResultSchema)
            );
            break;
          case 'state-message-query':
            work = client.call(
              request.op,
              request.payload,
              decoder(Schema.Array(stateMessageHitSchema))
            );
            break;
          case 'state-message-purge':
            work = client.call(request.op, request.payload, decoder(Schema.Boolean));
            break;
          case 'state-health':
            work = client.call(request.op, request.payload, decoder(stateHealthSchema));
            break;
          case 'state-stats':
            work = client.call(request.op, request.payload, decoder(stateStatsSchema));
            break;
          case 'state-match':
            work = client.call(
              request.op,
              request.payload,
              decoder(Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))))
            );
            break;
          case 'state-search':
            work = client.call(
              request.op,
              request.payload,
              decoder(Schema.Array(stateSearchHitSchema))
            );
            break;
          case 'state-search-pending':
            work = client.call(
              request.op,
              request.payload,
              decoder(Schema.Array(stateSearchPendingRowSchema))
            );
            break;
          case 'prompt-vectors':
            work = client.call(request.op, request.payload, decoder(promptVectorReplySchema));
            break;
          case 'state-search-vectors':
            work = client.call(
              request.op,
              request.payload,
              decoder(stateSearchVectorsResultSchema)
            );
            break;
          case 'state-search-coverage':
            work = client.call(
              request.op,
              request.payload,
              decoder(stateSearchCoverageResultSchema)
            );
            break;
          case 'state-search-similar':
            work = client.call(
              request.op,
              request.payload,
              decoder(Schema.Array(stateSearchSimilarHitSchema))
            );
            break;
          case 'state-rebuild':
          case 'state-catch-up':
          case 'state-catch-up-step':
          case 'state-reindex':
            work = client.call(request.op, request.payload, decoder(Schema.Boolean));
            break;
          case 'state-gc-check':
            work = client.call(request.op, request.payload, decoder(stateCountsSchema));
            break;
          case 'state-drop-thread':
            work = client.call(request.op, request.payload, decoder(Schema.Array(Schema.String)));
            break;
          case 'replace-file-bindings':
            connection.scoped.replaceBindings(request.payload);
            work = client.call(request.op, request.payload, decoder(Schema.Boolean));
            break;
          case 'prepare-scoped-file':
            work = connection.scoped.prepare(request.payload);
            break;
          case 'read-scoped-file-page':
            work = connection.scoped.readFilePage(request.payload);
            break;
          case 'read-scoped-file-chunk-bounds':
            work = connection.scoped.readFileChunkBounds(request.payload);
            break;
          case 'search-scopes':
            work = connection.scoped.search(request.payload);
            break;
          case 'coverage-scope':
            work = connection.scoped.coverage(request.payload);
            break;
          case 'coverage-batch':
            work = connection.scoped.coverageBatch(request.payload);
            break;
          case 'verify-scoped-manifest':
            work = connection.scoped.verifyManifest(request.payload);
            break;
          case 'remove-scoped-file': {
            const removal = decoder(scopedRemoveSchema)(request.payload);
            connection.scoped.authority.authorize([removal.scope]);
            connection.scoped.authority.file(removal.fileId, removal.scope);
            connection.scoped.authority.revision += 1;
            work = client.call(request.op, removal, decoder(Schema.Boolean));
            break;
          }
          case 'info':
            decoder(Schema.Null)(request.payload);
            work = { ...nativeInfo, ...connection.identity };
            break;
          case 'prepare-file':
            work = connection.prepare(request.payload);
            break;
          case 'verify-manifest':
            work = connection.verifyManifest(request.payload);
            break;
          case 'coverage':
            work = connection.coverage(request.payload);
            break;
          case 'search':
            work = connection.search(request.payload);
            break;
          case 'configure-vector-profile':
            work = client.call(request.op, request.payload, decoder(identityStateSchema));
            break;
          case 'commit-scoped-file':
          case 'commit-scoped-text-file':
          case 'commit-file':
          case 'commit-text-file':
            work = client.call(request.op, request.payload, decoder(commitResultSchema));
            break;
          case 'purge-file':
          case 'remove-file':
            work = client.call(request.op, request.payload, decoder(Schema.Boolean));
            break;
          case 'close':
            decoder(Schema.Null)(request.payload);
            work = close();
            break;
          default:
            throw new IndexerError('invalid-operation', `Unknown indexer operation ${request.op}.`);
        }
        Promise.resolve(work).then(
          (value) => {
            send({ id: request.id, kind: 'response', ok: true, value });
            if (request.op === 'close') {
              endpoint.finish();
            }
          },
          (error: unknown) => {
            send({ error: fault(error), id: request.id, kind: 'response', ok: false });
            if (request.op === 'close') {
              endpoint.finish();
            }
          }
        );
      } catch (error) {
        if (id === undefined) {
          send({ error: fault(error), kind: 'startup-error' });
        } else {
          send({ error: fault(error), id, kind: 'response', ok: false });
        }
      }
    };
    send({ kind: 'ready', value: nativeInfo });
  } catch (error) {
    if (closing && closePromise) {
      // The early Close response owns the outcome; do not emit a contradictory
      // startup-error when that same close caused the writer-ready rejection.
      await closePromise.catch(() => undefined);
      return;
    }
    const failures: unknown[] = [error];
    try {
      reader?.db.close();
    } catch (failure) {
      failures.push(failure);
    }
    try {
      await worker?.terminate();
    } catch (failure) {
      failures.push(failure);
    }
    send({
      error: fault(
        failures.length === 1
          ? error
          : new AggregateError(failures, 'Indexer startup cleanup failed.')
      ),
      kind: 'startup-error',
    });
    endpoint.finish();
  }
}
