import { parentPort, workerData } from 'node:worker_threads';
import { Schema } from 'effect';
import {
  decoder,
  fault,
  IndexerError,
  requestSchema,
  STATE_CATCH_UP_STEP_EVENTS,
} from './contracts.ts';
import { openDesktopIndex } from './desktop-index-connection.ts';
import { loadStateProjection } from './state-projection.ts';
import { IndexWriter } from './store.ts';
import { validateIndexerOptions } from './transport.ts';

const port = parentPort;
if (!port) {
  throw new Error('Indexer writer requires a worker parent port.');
}
let writer: IndexWriter;
try {
  const options = validateIndexerOptions(workerData);
  const projection = await loadStateProjection(options.stateProjection, options.stateRoot);
  writer = new IndexWriter(options, openDesktopIndex(options), projection);
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
        case 'state-health':
          decoder(Schema.Null)(request.payload);
          value = writer.state.health();
          break;
        case 'state-stats':
          value = writer.state.stats(request.payload);
          break;
        case 'state-match':
          value = writer.state.match(request.payload);
          break;
        case 'state-search':
          value = writer.state.search(request.payload, STATE_CATCH_UP_STEP_EVENTS);
          break;
        case 'state-rebuild':
          value = writer.state.rebuild(request.payload);
          break;
        case 'state-catch-up-step':
          value = writer.state.catchUpStep(request.payload);
          break;
        case 'state-reindex':
          value = writer.state.reindex(request.payload);
          break;
        case 'state-gc-check':
          value = writer.state.gcCheck(request.payload, STATE_CATCH_UP_STEP_EVENTS);
          break;
        case 'state-drop-thread':
          value = writer.state.dropThread(request.payload);
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
      // A read refused as behind is the transport's cue to step again, not a failure.
      if (stateOperation && !(error instanceof IndexerError && error.code === 'state-behind')) {
        writer.state.recordFailure(error);
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
