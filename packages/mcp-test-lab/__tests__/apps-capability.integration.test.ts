import {
  Client,
  type ClientCapabilities,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { APPS_PROFILE } from '../src/apps-profile';
import { startMcpLabScenario } from '../src/lab';

async function readAppDocument(capabilities: ClientCapabilities | undefined): Promise<string> {
  const lab = await startMcpLabScenario('apps-reference', { execution: 'in-process' });
  if (lab.endpoint.kind !== 'in-process-http') {
    throw new Error(`Expected in-process HTTP endpoint, received ${lab.endpoint.kind}`);
  }
  const client = new Client(
    { name: 'brainstrike-mcp-lab-apps-capability-test', version: '1.0.0' },
    {
      ...(capabilities ? { capabilities } : {}),
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    }
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(lab.endpoint.url, { fetch: lab.endpoint.fetch })
    );
    const result = await client.readResource({ uri: APPS_PROFILE.resource.uri });
    const [content] = result.contents;
    if (content === undefined || !('text' in content)) {
      throw new Error('MCP Apps reference resource returned no text content');
    }
    return content.text;
  } finally {
    await client.close();
    await lab.close();
  }
}

describe('MCP Apps reference capability negotiation', () => {
  it('serves the app document only to a client advertising the Apps host capability', async () => {
    await expect(readAppDocument(undefined)).rejects.toThrow(/host capability/u);
    await expect(
      readAppDocument({
        extensions: {
          [APPS_PROFILE.extensionId]: { mimeTypes: [...APPS_PROFILE.host.mimeTypes] },
        },
      })
    ).resolves.toBe(APPS_PROFILE.document);
    await expect(
      readAppDocument({ extensions: { [APPS_PROFILE.extensionId]: { mimeTypes: ['text/html'] } } })
    ).rejects.toThrow(/host capability/u);
  });
});
