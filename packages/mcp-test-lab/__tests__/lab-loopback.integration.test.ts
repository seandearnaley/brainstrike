import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { startMcpLabScenario } from '../src/lab';

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
      expect(lab.endpoint.url.port).not.toBe('0');
      const client = new Client(
        { name: 'brainstrike-mcp-lab-loopback-test', version: '1.0.0' },
        { versionNegotiation }
      );

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
        await client.close();
      }

      await expect(lab.close()).resolves.toEqual({
        httpListenersClosed: 1,
        stdioTransportsClosed: 0,
        untriggeredFaultIds: [],
      });
      expect(lab.closed).toBe(true);
      await expect(fetch(lab.endpoint.url)).rejects.toThrow();
    }
  );
});
