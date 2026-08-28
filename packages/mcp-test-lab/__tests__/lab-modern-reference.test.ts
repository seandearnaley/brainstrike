import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { startMcpLabScenario } from '../src/lab';

describe('MCP lab modern reference', () => {
  it('negotiates 2026-07-28 and exercises a real official SDK tool exchange', async () => {
    const lab = await startMcpLabScenario('modern-reference', { execution: 'in-process' });
    if (lab.endpoint.kind !== 'in-process-http') {
      throw new Error(`Expected in-process HTTP endpoint, received ${lab.endpoint.kind}`);
    }
    const client = new Client(
      { name: 'brainstrike-mcp-lab-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    const transport = new StreamableHTTPClientTransport(lab.endpoint.url, {
      fetch: lab.endpoint.fetch,
    });

    try {
      await client.connect(transport);

      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(client.getServerVersion()).toEqual({
        name: 'brainstrike-sdk-v2-reference',
        version: '2.0.0',
      });

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(['echo']);

      const result = await client.callTool({
        arguments: { text: 'verified' },
        name: 'echo',
      });
      expect(result).toMatchObject({
        content: [{ text: 'verified', type: 'text' }],
        structuredContent: { text: 'verified' },
      });
    } finally {
      await client.close();
      await expect(lab.close()).resolves.toEqual({
        httpListenersClosed: 0,
        stdioTransportsClosed: 0,
        untriggeredFaultIds: [],
      });
    }

    expect(lab.closed).toBe(true);
  });
});
