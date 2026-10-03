import { createQueryHost } from './host-core.js';

if (!('parentPort' in process)) {
  throw new Error('SQLite query utility host requires an Electron parent port.');
}
const port = process.parentPort;
if (
  !(
    typeof port === 'object' &&
    port !== null &&
    'on' in port &&
    typeof port.on === 'function' &&
    'postMessage' in port &&
    typeof port.postMessage === 'function'
  )
) {
  throw new Error('SQLite query utility host has an invalid Electron parent port.');
}
const postMessage = port.postMessage.bind(port);
const receive = createQueryHost((response) => {
  postMessage(response);
});
port.on('message', (event: unknown): void => {
  if (!(typeof event === 'object' && event !== null && 'data' in event)) {
    process.exit(1);
  }
  receive(event.data);
});
