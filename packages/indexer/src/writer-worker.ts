import { parentPort, workerData } from 'node:worker_threads';
import { Schema } from 'effect';
import { decoder, fault, IndexerError, requestSchema } from './contracts.js';
import { IndexWriter } from './store.js';

const port = parentPort;
if (!port) {
  throw new Error('Indexer writer requires a worker parent port.');
}
let writer: IndexWriter;
try {
  writer = new IndexWriter(workerData);
  port.postMessage({ kind: 'ready', value: writer.info });
  port.on('message', (input: unknown) => {
    let id: number | undefined;
    let closing = false;
    try {
      const request = decoder(requestSchema)(input);
      id = request.id;
      let value: unknown;
      switch (request.op) {
        case 'commit-file':
          value = writer.commit(request.payload);
          break;
        case 'remove-file':
          value = writer.remove(request.payload);
          break;
        case 'close':
          decoder(Schema.Null)(request.payload);
          closing = true;
          writer.db.close();
          value = true;
          break;
        default:
          throw new IndexerError('invalid-operation', `Unknown writer operation ${request.op}.`);
      }
      port.postMessage({ id, kind: 'response', ok: true, value });
    } catch (error) {
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
