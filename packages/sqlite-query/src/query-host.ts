import { createQueryHost } from './host-core.js';

if (!process.send) {
  throw new Error('Node SQLite query host must have a parent IPC channel.');
}
const send = process.send.bind(process);
process.on(
  'message',
  createQueryHost((response) => {
    send(response);
  })
);
process.on('disconnect', (): void => {
  process.exit(0);
});
