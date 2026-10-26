import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';

/** A server that ignores stdin end and SIGTERM and never answers the handshake. */
const STUBBORN_SERVER = `
process.on('SIGTERM', () => undefined);
process.stdin.on('data', () => undefined);
process.stdin.on('end', () => undefined);
process.stderr.write(String(process.pid) + '\\n');
setInterval(() => undefined, 1 << 30);
`;

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Explicit stdio MCP close', () => {
  it('returns while the child ignores stdin end and SIGTERM, and the child is killed', async () => {
    // No timer advances: a close that waits out a grace period never returns.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const started = Promise.withResolvers<number>();
    const client = new ExplicitStdioMcpClient({
      args: ['-e', STUBBORN_SERVER],
      command: process.execPath,
      name: 'stubborn',
      onStderr: (chunk) => {
        const pid = Number.parseInt(chunk, 10);
        if (Number.isSafeInteger(pid) && pid > 0) {
          started.resolve(pid);
        }
      },
    });
    const connecting = client.connect();
    const connectRejected = expect(connecting).rejects.toBeDefined();
    const pid = await started.promise;

    await expect(client.close()).resolves.toBeUndefined();

    await connectRejected;
    await expect.poll(() => processIsGone(pid)).toBe(true);
  }, 10_000);
});
