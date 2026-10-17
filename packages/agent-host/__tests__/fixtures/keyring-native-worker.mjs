import { parentPort, workerData } from 'node:worker_threads';

const port = parentPort;
if (!port) {
  throw new Error('Owned credential fixture requires its parent channel');
}
const release = Promise.withResolvers();
const pending = new Set();
const values = new Map();
port.on('message', (request) => {
  if (request.release === true) {
    release.resolve();
    return;
  }
  const operation = (async () => {
    switch (request.operation) {
      case 'read':
        if (request.account === 'held-native-call') {
          workerData.observationPort.postMessage({ fixture: 'native-call-entered' });
          await release.promise;
          return 'held result';
        }
        return values.get(request.account) ?? null;
      case 'write':
        values.set(request.account, request.value);
        return null;
      case 'delete':
        return values.delete(request.account);
      case 'listAccounts':
        return [...values.keys()];
      case 'close':
        await Promise.allSettled([...pending]);
        return null;
      default:
        throw new Error('Unknown fixture operation');
    }
  })();
  if (request.operation !== 'close') {
    pending.add(operation);
  }
  operation.then(
    (value) => {
      pending.delete(operation);
      port.postMessage({ id: request.id, ok: true, value });
      if (request.operation === 'close') {
        workerData.observationPort.close();
        port.close();
      }
    },
    () => {
      pending.delete(operation);
      port.postMessage({ id: request.id, ok: false });
    }
  );
});
