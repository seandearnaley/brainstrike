import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  type McpLabInProcessHttpEndpoint,
  type McpLabSession,
  startMcpLabScenario,
} from '../src/lab';
import { ECHO_REFERENCE_CONTENT } from '../src/reference-server';
import { expectReferenceToolContract } from './reference-tool-contract';

type VersionNegotiation = NonNullable<
  NonNullable<ConstructorParameters<typeof Client>[1]>['versionNegotiation']
>;

const startUnchecked = startMcpLabScenario as unknown as (
  id: string,
  options: unknown
) => Promise<McpLabSession>;

function requireInProcessEndpoint(lab: McpLabSession): McpLabInProcessHttpEndpoint {
  if (lab.endpoint.kind !== 'in-process-http') {
    throw new Error(`Expected in-process HTTP endpoint, received ${lab.endpoint.kind}`);
  }
  return lab.endpoint;
}

function createInitializeRequest(
  url: URL,
  protocolVersion: '2025-11-25' | '2026-07-28',
  modernEnvelope: boolean
): Request {
  return new Request(url, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        ...(modernEnvelope
          ? {
              _meta: {
                'io.modelcontextprotocol/clientCapabilities': {},
                'io.modelcontextprotocol/clientInfo': {
                  name: 'brainstrike-era-isolation-test',
                  version: '1.0.0',
                },
                'io.modelcontextprotocol/protocolVersion': protocolVersion,
              },
            }
          : {}),
        capabilities: {},
        clientInfo: { name: 'brainstrike-era-isolation-test', version: '1.0.0' },
        protocolVersion,
      },
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

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
    expectReferenceToolContract((await client.listTools()).tools);
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
  it('advertises a non-routable endpoint and rejects requests for any other URL', async () => {
    const lab = await startMcpLabScenario('modern-reference', { execution: 'in-process' });
    const endpoint = requireInProcessEndpoint(lab);

    try {
      expect(endpoint.url.hostname).toBe('mcp-lab.invalid');
      await expect(
        endpoint.fetch(new URL('/wrong', endpoint.url), {
          method: 'POST',
        })
      ).rejects.toThrow(/does not match the advertised endpoint/);
    } finally {
      await lab.close();
    }
  });

  it('rejects endpoint use after the lab session closes', async () => {
    const lab = await startMcpLabScenario('modern-reference', { execution: 'in-process' });
    const endpoint = requireInProcessEndpoint(lab);
    await lab.close();

    await expect(
      endpoint.fetch(endpoint.url, {
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'initialize', params: {} }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    ).rejects.toThrow('MCP lab session is closed');
  });

  it('rejects a modern initialize request at the legacy-only reference', async () => {
    const lab = await startMcpLabScenario('legacy-reference', { execution: 'in-process' });
    const endpoint = requireInProcessEndpoint(lab);

    try {
      const response = await endpoint.fetch(
        createInitializeRequest(endpoint.url, '2026-07-28', true)
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'mcp_lab_legacy_only' });
    } finally {
      await lab.close();
    }
  });

  it('rejects a legacy initialize request at the modern-only reference', async () => {
    const lab = await startMcpLabScenario('modern-reference', { execution: 'in-process' });
    const endpoint = requireInProcessEndpoint(lab);

    try {
      const response = await endpoint.fetch(
        createInitializeRequest(endpoint.url, '2025-11-25', false)
      );
      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toContain('Unsupported protocol version');
    } finally {
      await lab.close();
    }
  });

  it('snapshots accessor-backed execution exactly once before routing', async () => {
    let executionReads = 0;
    const options = Object.defineProperty({}, 'execution', {
      enumerable: true,
      get() {
        executionReads += 1;
        return executionReads === 1 ? 'in-process' : 'loopback';
      },
    });
    const lab = await startMcpLabScenario('modern-reference', options as never);

    try {
      expect(lab.endpoint.kind).toBe('in-process-http');
      expect(executionReads).toBe(1);
    } finally {
      await lab.close();
    }
  });

  it('negotiates the pinned modern protocol through a real SDK exchange', async () => {
    const lab = await startMcpLabScenario('modern-reference', { execution: 'in-process' });
    const endpoint = requireInProcessEndpoint(lab);
    const client = new Client(
      { name: 'brainstrike-official-modern-reference-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );

    try {
      await client.connect(
        new StreamableHTTPClientTransport(endpoint.url, { fetch: endpoint.fetch })
      );
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(client.getServerVersion()).toEqual({
        name: 'mcp-conformance-test-server',
        version: '1.0.0',
      });
      expect(client.getServerCapabilities()).toMatchObject({
        completions: {},
        prompts: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        tools: { listChanged: true },
      });
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain(
        'test_simple_text'
      );
      expect(await client.callTool({ name: 'test_simple_text' })).toMatchObject({
        content: [{ text: 'This is a simple text response for testing.', type: 'text' }],
      });
      expect((await client.listResources()).resources).toContainEqual(
        expect.objectContaining({ uri: 'test://static-text' })
      );
      expect(await client.readResource({ uri: 'test://static-text' })).toMatchObject({
        contents: [
          {
            text: 'This is the content of the static text resource.',
            uri: 'test://static-text',
          },
        ],
      });
      expect((await client.listPrompts()).prompts.map(({ name }) => name)).toContain(
        'test_simple_prompt'
      );
      expect(await client.getPrompt({ name: 'test_simple_prompt' })).toMatchObject({
        messages: [
          { content: { text: 'This is a simple prompt for testing.', type: 'text' }, role: 'user' },
        ],
      });
    } finally {
      try {
        await client.close();
      } finally {
        await lab.close();
      }
    }
  });

  it('negotiates the explicit legacy protocol through a real SDK exchange', async () => {
    await verifyReferenceExchange('legacy-reference', { mode: 'legacy' }, '2025-11-25');
  });

  it('serves the echo reference resource, prompt, and prompt-argument completion (BST-1592)', async () => {
    const lab = await startMcpLabScenario('legacy-reference', { execution: 'in-process' });
    const endpoint = requireInProcessEndpoint(lab);
    const client = new Client(
      { name: 'brainstrike-mcp-lab-content-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'legacy' } }
    );
    const { prompt, resource } = ECHO_REFERENCE_CONTENT;
    try {
      await client.connect(
        new StreamableHTTPClientTransport(endpoint.url, { fetch: endpoint.fetch })
      );
      // The catalog surfaces resources/prompts/completion only when the server
      // negotiates the capability, so assert the inferred set first.
      expect(Object.keys(client.getServerCapabilities() ?? {}).sort()).toEqual([
        'completions',
        'prompts',
        'resources',
        'tools',
      ]);
      expect((await client.listResources()).resources).toContainEqual(
        expect.objectContaining({ mimeType: resource.mimeType, uri: resource.uri })
      );
      expect((await client.readResource({ uri: resource.uri })).contents).toEqual([
        { mimeType: resource.mimeType, text: resource.text, uri: resource.uri },
      ]);
      expect((await client.listPrompts()).prompts).toContainEqual(
        expect.objectContaining({
          arguments: [expect.objectContaining({ name: prompt.argument, required: true })],
          name: prompt.name,
        })
      );
      expect(
        (await client.getPrompt({ arguments: { [prompt.argument]: 'topic' }, name: prompt.name }))
          .messages
      ).toEqual([{ content: { text: prompt.message('topic'), type: 'text' }, role: 'user' }]);
      const completion = await client.complete({
        argument: { name: prompt.argument, value: 'bst-1592-a' },
        ref: { name: prompt.name, type: 'ref/prompt' },
      });
      expect(completion.completion.values).toEqual(['bst-1592-alpha']);
    } finally {
      await client.close();
      await lab.close();
    }
  });

  it.each([
    ['missing execution', 'modern-reference', {}, /requires explicit execution/],
    [
      'unknown execution',
      'modern-reference',
      { execution: 'automatic' },
      /execution must be "in-process"/,
    ],
    [
      'unknown option',
      'modern-reference',
      { execution: 'in-process', fallback: true },
      /expected only optional "execution"/,
    ],
    [
      'OAuth fixture',
      'oauth-reference',
      { execution: 'in-process' },
      /requires a loopback listener/,
    ],
    [
      'stdio fixture',
      'stdio-reference',
      { execution: 'in-process' },
      /stdio scenario does not accept execution/,
    ],
  ])('rejects invalid or unavailable %s input', async (_label, scenarioId, options, expected) => {
    await expect(startUnchecked(scenarioId, options)).rejects.toThrow(expected);
  });
});
