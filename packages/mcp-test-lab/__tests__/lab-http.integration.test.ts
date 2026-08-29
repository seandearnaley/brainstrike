import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { startMcpLabScenario } from '../src/lab';

type VersionNegotiation = NonNullable<
  NonNullable<ConstructorParameters<typeof Client>[1]>['versionNegotiation']
>;

async function verifyReferenceExchange(
  scenarioId: 'legacy-reference' | 'modern-reference',
  versionNegotiation: VersionNegotiation,
  expectedVersion: '2025-11-25' | '2026-07-28'
): Promise<void> {
  const lab = await startMcpLabScenario(scenarioId, { execution: 'in-process' });
  if (lab.endpoint.kind !== 'in-process-http') {
    throw new Error(`Expected in-process HTTP endpoint, received ${lab.endpoint.kind}`);
  }
  const client = new Client(
    { name: 'brainstrike-mcp-lab-http-test', version: '1.0.0' },
    { versionNegotiation }
  );

  try {
    await client.connect(
      new StreamableHTTPClientTransport(lab.endpoint.url, { fetch: lab.endpoint.fetch })
    );
    expect(client.getNegotiatedProtocolVersion()).toBe(expectedVersion);
    expect(client.getServerVersion()).toEqual({
      name: 'brainstrike-sdk-v2-reference',
      version: '2.0.0',
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(
      await client.callTool({ arguments: { text: expectedVersion }, name: 'echo' })
    ).toMatchObject({
      content: [{ text: expectedVersion, type: 'text' }],
      structuredContent: { text: expectedVersion },
    });
  } finally {
    await client.close();
  }

  const firstReport = await lab.close();
  const secondReport = await lab.close();
  expect(firstReport).toBe(secondReport);
  expect(firstReport).toEqual({
    httpListenersClosed: 0,
    stdioTransportsClosed: 0,
    untriggeredFaultIds: [],
  });
  expect(lab.closed).toBe(true);
  expect(lab.scenario.availability).toBe('executable');
  expect(lab.scenario.usesAmbientCredentials).toBe(false);
}

describe('MCP lab in-process HTTP references', () => {
  it('negotiates the pinned modern protocol through a real SDK exchange', async () => {
    await verifyReferenceExchange(
      'modern-reference',
      { mode: { pin: '2026-07-28' } },
      '2026-07-28'
    );
  });

  it('negotiates the explicit legacy protocol through a real SDK exchange', async () => {
    await verifyReferenceExchange('legacy-reference', { mode: 'legacy' }, '2025-11-25');
  });

  it.each([
    ['missing execution', 'modern-reference', {}],
    ['unknown execution', 'modern-reference', { execution: 'automatic' }],
    ['unknown option', 'modern-reference', { execution: 'in-process', fallback: true }],
    ['OAuth fixture', 'oauth-reference', { execution: 'in-process' }],
    ['stdio fixture', 'stdio-reference', { execution: 'in-process' }],
  ])('rejects %s before creating a session', async (_label, scenarioId, options) => {
    await expect(startMcpLabScenario(scenarioId, options as never)).rejects.toThrow(
      /MCP lab.*(?:execution|option|not executable)/i
    );
  });
});
