// The UI side of the SIGKILL harness, a separate process (M0-A1 scripts/dur/d3-recorder.mjs): every chunk line the host
// sends is appended to its own file and fsynced BEFORE it counts as shown. Only complete lines count (a partial line at
// the host's death was never shown).
// usage: node recorder.mjs <socketPath | \\.\pipe\name> <outFile>
import { closeSync, fsyncSync, openSync, rmSync, writeSync } from 'node:fs';
import net from 'node:net';

const [sock, outFile] = process.argv.slice(2);
if (process.platform !== 'win32') {
  rmSync(sock, { force: true });
}
const fd = openSync(outFile, 'w');
let buf = '';
let lines = 0;
const server = net.createServer((conn) => {
  conn.setEncoding('utf8');
  conn.on('data', (d) => {
    buf += d;
    const cut = buf.lastIndexOf('\n');
    if (cut < 0) {
      return;
    }
    const complete = buf.slice(0, cut + 1);
    buf = buf.slice(cut + 1);
    writeSync(fd, complete);
    fsyncSync(fd); // shown only once durable on the recorder's side
    lines += complete.split('\n').length - 1;
  });
  const done = () => {
    fsyncSync(fd);
    closeSync(fd);
    server.close();
    process.stdout.write(`RECORDED ${lines} partialBytes=${buf.length}\n`);
    process.exit(0);
  };
  conn.on('close', done);
  conn.on('error', () => undefined); // ECONNRESET on SIGKILL of the peer: 'close' follows
});
server.listen(sock, () => process.stdout.write('LISTENING\n'));
setTimeout(() => {
  process.stderr.write('recorder: no host within 60 s\n');
  process.exit(2);
}, 60_000).unref();
