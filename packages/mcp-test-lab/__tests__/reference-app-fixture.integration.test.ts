import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { startReferenceElicitationAppFixture } from '../src/reference-app-fixture';

const APP = {
  document: '<!doctype html><body>reference app</body>',
  resourceUri: 'ui://reference/app.html',
} as const;

it('serves the reference elicit_confirm as an MCP App tool over modern-era loopback HTTP', async () => {
  const fixture = await startReferenceElicitationAppFixture(APP);
  const elicitations: string[] = [];
  const client = new Client(
    { name: 'brainstrike-reference-app-test', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      inputRequired: { autoFulfill: true, maxRounds: 2 },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    }
  );
  client.setRequestHandler('elicitation/create', async (request) => {
    elicitations.push(request.params.message);
    return { action: 'accept', content: { confirm: true } };
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(fixture.url)));
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

    const { tools } = await client.listTools();
    expect(tools.map(({ _meta, name }) => ({ _meta, name }))).toEqual([
      { _meta: { ui: { resourceUri: APP.resourceUri } }, name: 'elicit_confirm' },
    ]);
    await expect(client.readResource({ uri: APP.resourceUri })).resolves.toMatchObject({
      contents: [
        { mimeType: 'text/html;profile=mcp-app', text: APP.document, uri: APP.resourceUri },
      ],
    });
    await expect(
      client.callTool({ arguments: { text: 'from-app' }, name: 'elicit_confirm' })
    ).resolves.toMatchObject({ structuredContent: { confirmed: true, text: 'from-app' } });
    expect(elicitations).toEqual(['Confirm the reference elicitation for "from-app".']);
  } finally {
    await client.close();
    await fixture.close();
  }
});
