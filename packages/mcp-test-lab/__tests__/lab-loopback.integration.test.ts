import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { startMcpLabScenario } from '../src/lab';

describe('MCP lab loopback lifecycle', () => {
  it('serves modern traffic on an ephemeral loopback port and proves listener cleanup', async () => {
    const lab = await startMcpLabScenario('modern-reference');
    if (lab.endpoint.kind !== 'loopback-http') {
      throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
    }
    expect(lab.endpoint.kind).toBe('loopback-http');
    expect(lab.endpoint.url.hostname).toBe('127.0.0.1');
    expect(lab.endpoint.url.port).not.toBe('0');

    const client = new Client(
      { name: 'brainstrike-mcp-lab-loopback-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } }
    );

    try {
      await client.connect(new StreamableHTTPClientTransport(lab.endpoint.url));
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
    } finally {
      await client.close();
    }

    await expect(lab.close()).resolves.toEqual({
      httpListenersClosed: 1,
      untriggeredFaultIds: [],
    });
    await expect(fetch(lab.endpoint.url)).rejects.toThrow();
  });
});
