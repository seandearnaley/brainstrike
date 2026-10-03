import type { Socket } from 'node:net';

export function receiveFrames<T>(
  socket: Socket,
  decode: (input: unknown) => T,
  receive: (frame: T) => void,
  fail: (cause: unknown) => void
): void {
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    try {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 8192) {
        throw new TypeError('Host handshake frame exceeds 8192 bytes');
      }
      let newline = buffered.indexOf(10);
      while (newline !== -1 && !socket.destroyed) {
        const line = new TextDecoder('utf-8', { fatal: true }).decode(
          buffered.subarray(0, newline)
        );
        buffered = buffered.subarray(newline + 1);
        receive(decode(JSON.parse(line)));
        newline = buffered.indexOf(10);
      }
    } catch (cause) {
      fail(cause);
    }
  });
}
export function sendFrame(socket: Socket, frame: unknown): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}
export async function destroySocket(socket: Socket): Promise<void> {
  if (socket.closed) {
    return;
  }
  await new Promise<void>((resolve) => {
    socket.once('close', resolve);
    socket.destroy();
  });
}
