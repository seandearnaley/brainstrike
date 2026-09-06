import { once } from 'node:events';
import { request as nodeRequest } from 'node:http';
import { connect } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  LOOPBACK_HTTP_FAULT_SCOPES,
  type McpLabHttpFaultExecutor,
} from '../src/http-fault-handler';
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

function requestLoopback(
  url: URL,
  method: string
): Promise<{
  readonly body: string;
  readonly rawHeaders: readonly string[];
  readonly status: number;
}> {
  return new Promise((resolve, reject) => {
    const request = nodeRequest(url, { headers: { origin: url.origin }, method }, (response) => {
      const chunks: Uint8Array[] = [];
      response.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      response.once('end', () =>
        resolve({
          body: Buffer.concat(chunks).toString(),
          rawHeaders: response.rawHeaders,
          status: response.statusCode ?? 0,
        })
      );
    });
    request.once('error', reject);
    request.end();
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
        const expectedTool = scenarioId === 'modern-reference' ? 'test_simple_text' : 'echo';
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
          scenarioId === 'modern-reference'
            ? ['test_simple_text', 'test_error_handling']
            : [expectedTool, 'elicit_confirm']
        );
        if (scenarioId === 'modern-reference') {
          expect(await client.callTool({ name: expectedTool })).toMatchObject({
            content: [{ text: 'This is a simple text response for testing.', type: 'text' }],
          });
        } else {
          expect(
            await client.callTool({ arguments: { text: scenarioId }, name: expectedTool })
          ).toMatchObject({ structuredContent: { text: scenarioId } });
          expect(
            await client.callTool({
              arguments: { extra: true, text: scenarioId },
              name: expectedTool,
            })
          ).toMatchObject({ isError: true });
        }
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

  it('preserves repeated Set-Cookie headers and cancels bodies forbidden by HTTP semantics', async () => {
    let cancelledBodies = 0;
    const handler = {
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === '/cookies') {
          const headers = new Headers();
          headers.append('set-cookie', 'first=one; Path=/');
          headers.append('set-cookie', 'second=two; Path=/');
          return new Response('payload', { headers });
        }
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelledBodies += 1;
          },
          start(controller) {
            controller.enqueue(new TextEncoder().encode('forbidden'));
            controller.close();
          },
        });
        const response = new Response(body);
        const forcedStatus = Number(new URL(request.url).pathname.slice(1));
        if (Number.isInteger(forcedStatus)) {
          Object.defineProperty(response, 'status', { value: forcedStatus });
        }
        return response;
      },
    } as unknown as McpHttpHandler;
    const loopback = await createMcpLabLoopback(handler);

    try {
      const cookies = await requestLoopback(new URL('/cookies', loopback.url), 'GET');
      expect(cookies.body).toBe('payload');
      expect(
        cookies.rawHeaders.filter((value) => value.toLowerCase().startsWith('first='))
      ).toEqual(['first=one; Path=/']);
      expect(
        cookies.rawHeaders.filter((value) => value.toLowerCase().startsWith('second='))
      ).toEqual(['second=two; Path=/']);
      for (const [method, status] of [
        ['HEAD', 200],
        ['GET', 204],
        ['GET', 304],
      ] as const) {
        const result = await requestLoopback(new URL(`/${status}`, loopback.url), method);
        expect(result).toMatchObject({ body: '', status });
      }
      expect(cancelledBodies).toBe(3);
    } finally {
      await loopback.close();
    }
  });

  it('cancels a streaming response when the client disconnects under backpressure', async () => {
    let cancelled: (() => void) | undefined;
    const bodyCancelled = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const handler = {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled?.();
            },
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
          })
        ),
    } as unknown as McpHttpHandler;
    const loopback = await createMcpLabLoopback(handler);
    const request = nodeRequest(
      loopback.url,
      { headers: { origin: loopback.url.origin }, method: 'GET' },
      (response) => {
        response.once('data', () => response.destroy());
      }
    );
    request.on('error', () => {
      // The deliberate disconnect may reset the request.
    });
    request.end();
    const timeout = timeoutAfter(500);

    try {
      await expect(Promise.race([bodyCancelled, timeout.promise])).resolves.toBeUndefined();
    } finally {
      timeout.stop();
      request.destroy();
      await loopback.close();
    }
  });

  it('aborts the web request when the client disconnects during handler dispatch', async () => {
    let dispatchStarted: (() => void) | undefined;
    let requestAborted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      requestAborted = resolve;
    });
    const handler = {
      fetch: async (request: Request) => {
        dispatchStarted?.();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) {
            requestAborted?.();
            resolve();
            return;
          }
          request.signal.addEventListener(
            'abort',
            () => {
              requestAborted?.();
              resolve();
            },
            { once: true }
          );
        });
        return Response.json({ aborted: true });
      },
    } as unknown as McpHttpHandler;
    const loopback = await createMcpLabLoopback(handler);
    const request = nodeRequest(loopback.url, {
      headers: { origin: loopback.url.origin },
      method: 'GET',
    });
    request.on('error', () => {
      // The deliberate disconnect may reset the request.
    });
    request.end();
    const timeout = timeoutAfter(500);

    try {
      await started;
      request.destroy();
      await expect(Promise.race([aborted, timeout.promise])).resolves.toBeUndefined();
    } finally {
      timeout.stop();
      request.destroy();
      await loopback.close();
    }
  });

  it('closes the fault executor when handler construction fails after binding', async () => {
    let executorCloseCalls = 0;
    const faultExecutor = {
      async close() {
        executorCloseCalls += 1;
      },
    } as unknown as McpLabHttpFaultExecutor;

    await expect(
      createMcpLabLoopback(
        () => {
          throw new Error('handler construction failed');
        },
        { faultExecutor }
      )
    ).rejects.toThrow('handler construction failed');
    expect(executorCloseCalls).toBe(1);
  });

  it('rejects an accepted loopback alias when it differs from the faulted advertised authority', async () => {
    let handlerCalls = 0;
    let prepareCalls = 0;
    const handler = {
      fetch: async () => {
        handlerCalls += 1;
        return Response.json({ ok: true });
      },
    } as unknown as McpHttpHandler;
    const faultExecutor = {
      async close() {},
      async prepare() {
        prepareCalls += 1;
      },
    } as unknown as McpLabHttpFaultExecutor;
    const loopback = await createMcpLabLoopback(handler, {
      faultExecutor,
      faultScopes: LOOPBACK_HTTP_FAULT_SCOPES,
    });

    try {
      await expect(
        postWithHeaders(loopback.url, {
          host: `localhost:${loopback.url.port}`,
          origin: loopback.url.origin,
        })
      ).resolves.toBe(400);
      expect(handlerCalls).toBe(0);
      expect(prepareCalls).toBe(0);
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
