'use strict';
const parentPort = process.parentPort;
if (!parentPort || process.type !== 'utility') {
  throw new Error('Expected Electron utility process.');
}
parentPort.once('message', (event) => {
  void import('@brainstrike/indexer/host').then(({ runIndexerProcess }) =>
    runIndexerProcess(event.data, {
      finish: () => setImmediate(() => process.exit()),
      onMessage: (listener) => parentPort.on('message', (message) => listener(message.data)),
      send: (value) => parentPort.postMessage(value),
    })
  );
});
