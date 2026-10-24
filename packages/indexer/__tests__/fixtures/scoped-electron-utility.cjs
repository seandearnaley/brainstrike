'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const parentPort = process.parentPort;
if (!parentPort || process.type !== 'utility') {
  throw new Error('Expected Electron utility process.');
}
parentPort.once('message', (event) => {
  // The suite's node runtime bundle (vitest.integration.config.mts) holds the indexer host.
  const host = pathToFileURL(path.join(process.env.BRAINSTRIKE_NODE_RUNTIME_BUNDLE, 'host.js')).href;
  void import(host).then(({ runIndexerProcess }) =>
    runIndexerProcess(event.data, {
      finish: () => setImmediate(() => process.exit()),
      onMessage: (listener) => parentPort.on('message', (message) => listener(message.data)),
      send: (value) => parentPort.postMessage(value),
    })
  );
});
