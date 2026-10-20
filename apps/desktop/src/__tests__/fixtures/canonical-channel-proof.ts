import { CanonicalUtilityChild } from '../../canonical-utility-child';

if (!process.send) {
  throw new Error('Canonical channel proof requires Node IPC');
}
const send = process.send.bind(process);
const child = new CanonicalUtilityChild((frame) => send(frame));
process.on('message', (frame: unknown) => child.receive(frame));

process.once('disconnect', () => {
  void child.close().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(String(error));
      process.exit(1);
    }
  );
});
