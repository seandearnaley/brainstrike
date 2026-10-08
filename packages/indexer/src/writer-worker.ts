import { parentPort, workerData } from 'node:worker_threads';
import { Schema } from 'effect';
import { decoder, fault, IndexerError, requestSchema } from './contracts.js';
import { loadStateProjection } from './state-projection.js';
import { IndexWriter } from './store.js';
import { validateIndexerOptions } from './transport.js';

const port = parentPort;
if (!port) {
  throw new Error('Indexer writer requires a worker parent port.');
}
let writer: IndexWriter;
try {
  const options = validateIndexerOptions(workerData);
  const projection = options.stateProjection
    ? await loadStateProjection(options.stateProjection, options.stateRoot)
    : undefined;
  writer = new IndexWriter(options, projection);
  port.postMessage({ kind: 'ready', value: writer.info });
  port.on('message', (input: unknown) => {
    let id: number | undefined;
    let closing = false;
    let stateOperation = false;
    try {
      const request = decoder(requestSchema)(input);
      id = request.id;
      stateOperation = request.op.startsWith('state-');
      let value: unknown;
      switch (request.op) {
        case 'state-observation-prepare':
          value = writer.requireState().observations.prepare(request.payload);
          break;
        case 'state-observation-upsert':
          value = writer.requireState().observations.upsert(request.payload);
          break;
        case 'state-observation-query':
          value = writer.requireState().observations.query(request.payload);
          break;
        case 'state-observation-purge':
          value = writer.requireState().observations.purge(request.payload);
          break;
        case 'state-message-prepare':
          value = writer.requireState().messages.prepare(request.payload);
          break;
        case 'state-message-upsert':
          value = writer.requireState().messages.upsert(request.payload);
          break;
        case 'state-message-query':
          value = writer.requireState().messages.query(request.payload);
          break;
        case 'state-message-purge':
          value = writer.requireState().messages.purge(request.payload);
          break;
        case 'state-health':
          decoder(Schema.Null)(request.payload);
          value = writer.requireState().health();
          break;
        case 'state-stats':
          value = writer.requireState().stats(request.payload);
          break;
        case 'state-match':
          value = writer.requireState().match(request.payload);
          break;
        case 'state-search':
          value = writer.requireState().search(request.payload);
          break;
        case 'state-rebuild':
          value = writer.requireState().rebuild(request.payload);
          break;
        case 'state-catch-up':
          value = writer.requireState().catchUp(request.payload);
          break;
        case 'state-reindex':
          value = writer.requireState().reindex(request.payload);
          break;
        case 'state-gc-check':
          value = writer.requireState().gcCheck(request.payload);
          break;
        case 'state-drop-thread':
          value = writer.requireState().dropThread(request.payload);
          break;
        case 'replace-file-bindings':
          value = writer.scoped.replaceBindings(request.payload);
          break;
        case 'commit-scoped-text-file':
          value = writer.scoped.commitText(request.payload);
          break;
        case 'commit-scoped-file':
          value = writer.scoped.commitVector(request.payload);
          break;
        case 'remove-scoped-file':
          value = writer.scoped.remove(request.payload);
          break;
        case 'configure-vector-profile':
          value = writer.configureVectorProfile(request.payload);
          break;
        case 'commit-file':
          value = writer.commit(request.payload);
          break;
        case 'commit-text-file':
          value = writer.commitText(request.payload);
          break;
        case 'purge-file':
          value = writer.purge(request.payload);
          break;
        case 'remove-file':
          value = writer.remove(request.payload);
          break;
        case 'close':
          decoder(Schema.Null)(request.payload);
          closing = true;
          writer.close();
          value = true;
          break;
        default:
          throw new IndexerError('invalid-operation', `Unknown writer operation ${request.op}.`);
      }
      port.postMessage({ id, kind: 'response', ok: true, value });
    } catch (error) {
      if (stateOperation) {
        writer.recordStateFailure(error);
      }
      if (id === undefined) {
        port.postMessage({ error: fault(error), kind: 'startup-error' });
      } else {
        port.postMessage({ error: fault(error), id, kind: 'response', ok: false });
      }
    } finally {
      if (closing) {
        port.close();
      }
    }
  });
} catch (error) {
  port.postMessage({ error: fault(error), kind: 'startup-error' });
  port.close();
}
