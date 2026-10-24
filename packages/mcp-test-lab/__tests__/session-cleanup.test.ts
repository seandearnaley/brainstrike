import { describe, expect, it } from 'vitest';
import { createMcpLabSessionCleanup, type McpLabCleanupResource } from '../src/session-cleanup';

function resource(
  kind: McpLabCleanupResource['kind'],
  close: () => Promise<void>
): McpLabCleanupResource {
  return { close, closed: false, kind };
}

describe('MCP session cleanup ownership', () => {
  it('shares concurrent attempts and retries only resources that remain owned', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const secretResourceError = 'Bearer sk-secret-cleanup-resource';
    let failSecond = true;
    const cleanup = createMcpLabSessionCleanup({
      oauthStateCounts: undefined,
      resources: [
        resource('handler', async () => {
          calls.push('handler');
          await firstReleased;
        }),
        resource('http-listener', async () => {
          calls.push('listener');
          if (failSecond) {
            failSecond = false;
            throw new Error(secretResourceError);
          }
        }),
      ],
    });

    const first = cleanup.close();
    const concurrent = cleanup.close();
    expect(concurrent).toBe(first);
    releaseFirst?.();
    const failure = await first.catch((error: unknown) => error);
    expect(failure).toMatchObject({
      failedResourceKinds: ['http-listener'],
      message: 'MCP lab cleanup failed for 1 resource(s): http-listener',
      name: 'McpLabResourceCleanupError',
    });
    expect(JSON.stringify(failure)).not.toContain(secretResourceError);
    expect(String(failure)).not.toContain(secretResourceError);
    expect(calls).toEqual(['handler', 'listener']);
    expect(cleanup.closed).toBe(false);

    const report = await cleanup.close();
    expect(calls).toEqual(['handler', 'listener', 'listener']);
    expect(report.httpListenersClosed).toBe(1);
    expect(cleanup.closed).toBe(true);
    expect(Object.isFrozen(report)).toBe(true);
    await expect(cleanup.close()).resolves.toBe(report);
  });
});
