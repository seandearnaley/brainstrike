import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Schema } from 'effect';
import {
  decoder,
  fault,
  IndexerError,
  infoSchema,
  optionsSchema,
  requestSchema,
  stateCountsSchema,
  stateHealthSchema,
  stateSearchHitSchema,
  stateStatsSchema,
} from './contracts.ts';
import { RpcClient } from './rpc-client.ts';

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
  let worker: Worker | undefined;
  let closing = false;
  let closePromise: Promise<boolean> | undefined;
  try {
    const options = decoder(optionsSchema)(input);
    worker = new Worker(
      new URL(`./writer-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
      { workerData: options }
    );
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
          // BST-2472: an early Close joins the writer's own startup instead of
          // terminating it. Termination can land while the writer's first
          // `new Database` loads the SQLite add-on, and the add-on then aborts
          // the whole process (exit 134), so the host's state DB never closes.
          // A writer that started is closed cooperatively; one whose startup
          // failed is already ending, and its teardown is joined.
          const started = await client.ready.then(
            () => true,
            () => false
          );
          if (started) {
            await client.call('close', null, decoder(Schema.Boolean));
          } else {
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
            // The exit code carries the outcome too: the parent may see the exit first.
            process.exitCode = 1;
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
          case 'state-rebuild':
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
          case 'info':
            decoder(Schema.Null)(request.payload);
            work = info;
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
              process.exitCode = 1;
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
    send({ kind: 'ready', value: info });
  } catch (error) {
    if (closing && closePromise !== undefined) {
      // The early Close response owns the outcome; do not emit a contradictory
      // startup-error when that same close caused the writer-ready rejection.
      await closePromise.catch(() => undefined);
      return;
    }
    const failures: unknown[] = [error];
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
