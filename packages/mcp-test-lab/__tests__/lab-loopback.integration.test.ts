import { once } from 'node:events';
import { request as nodeRequest } from 'node:http';
import { connect } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { startMcpLabScenario } from '../src/lab';
import { createMcpLabLoopback } from '../src/loopback-http';

function timeoutAfter(milliseconds: number): {
  readonly promise: Promise<never>;
  readonly stop: () => void;
} {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return {
    promise: new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`MCP lab cleanup exceeded ${milliseconds}ms`)),
        milliseconds
      );
    }),
    stop: () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    },
  };
}

function postWithHeaders(url: URL, headers: Readonly<Record<string, string>>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = nodeRequest(
      url,
      { headers: { 'content-type': 'application/json', ...headers }, method: 'POST' },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      }
    );
    request.once('error', reject);
    request.end('{}');
  });
}

describe('MCP lab loopback HTTP references', () => {
  it.each([
    ['modern-reference', { mode: { pin: '2026-07-28' } }, '2026-07-28'],
    ['legacy-reference', { mode: 'legacy' }, '2025-11-25'],
  ] as const)(
    'serves %s on an ephemeral loopback port and proves listener cleanup',
    async (scenarioId, versionNegotiation, expectedVersion) => {
      const lab = await startMcpLabScenario(scenarioId, { execution: 'loopback' });
      if (lab.endpoint.kind !== 'loopback-http') {
        throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
      }
      expect(lab.endpoint.url.hostname).toBe('127.0.0.1');
      expect(Number(lab.endpoint.url.port)).toBeGreaterThan(0);
      const client = new Client(
        { name: 'brainstrike-mcp-lab-loopback-test', version: '1.0.0' },
        { versionNegotiation }
      );

      let report: Awaited<ReturnType<typeof lab.close>> | undefined;
      try {
        await client.connect(new StreamableHTTPClientTransport(lab.endpoint.url));
        expect(client.getNegotiatedProtocolVersion()).toBe(expectedVersion);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
        expect(
          await client.callTool({ arguments: { text: scenarioId }, name: 'echo' })
        ).toMatchObject({
          structuredContent: { text: scenarioId },
        });
      } finally {
        try {
          await client.close();
        } finally {
          report = await lab.close();
        }
      }

      expect(report).toEqual({
        httpListenersClosed: 1,
        stdioTransportsClosed: 0,
        untriggeredFaultIds: [],
      });
      expect(lab.closed).toBe(true);
    }
  );

  it('forces an accepted socket closed during deterministic lab cleanup', async () => {
    const lab = await startMcpLabScenario('modern-reference', { execution: 'loopback' });
    if (lab.endpoint.kind !== 'loopback-http') {
      throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
    }
    const socket = connect({
      host: lab.endpoint.url.hostname,
      port: Number(lab.endpoint.url.port),
    });
    const socketClosed = new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
    });
    socket.on('error', () => {
      // Forced cleanup may surface ECONNRESET to the deliberately incomplete request.
    });
    await once(socket, 'connect');
    socket.write(
      [
        'POST /mcp HTTP/1.1',
        `Host: ${lab.endpoint.url.host}`,
        `Origin: ${lab.endpoint.url.origin}`,
        'Content-Type: application/json',
        'Content-Length: 100',
        '',
        '{',
      ].join('\r\n')
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const timeout = timeoutAfter(500);

    try {
      await expect(Promise.race([lab.close(), timeout.promise])).resolves.toMatchObject({
        httpListenersClosed: 1,
      });
      if (!socket.destroyed) {
        await Promise.race([socketClosed, timeout.promise]);
      }
      expect(socket.destroyed).toBe(true);
    } finally {
      timeout.stop();
      socket.destroy();
      await lab.close();
    }
  });

  it('returns the handler failure message instead of an opaque loopback 500', async () => {
    const handler = {
      fetch: async () => {
        throw new Error('reference handler exploded');
      },
    } as unknown as McpHttpHandler;
    const loopback = await createMcpLabLoopback(handler);

    try {
      const response = await fetch(loopback.url, {
        body: '{}',
        headers: { 'content-type': 'application/json', origin: loopback.url.origin },
        method: 'POST',
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: 'mcp_lab_handler_error',
        message: 'reference handler exploded',
      });
    } finally {
      await loopback.close();
    }
  });

  it.each([
    ['host', (url: URL) => ({ host: 'attacker.invalid', origin: url.origin })],
    ['origin', (url: URL) => ({ host: url.host, origin: 'https://attacker.invalid' })],
  ] as const)('rejects a hostile %s before invoking the MCP handler', async (_kind, headers) => {
    let handlerCalls = 0;
    const handler = {
      fetch: async () => {
        handlerCalls += 1;
        return Response.json({ ok: true });
      },
    } as unknown as McpHttpHandler;
    const loopback = await createMcpLabLoopback(handler);

    try {
      await expect(postWithHeaders(loopback.url, headers(loopback.url))).resolves.toBe(403);
      expect(handlerCalls).toBe(0);
    } finally {
      await loopback.close();
    }
  });
});
