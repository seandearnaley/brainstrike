import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type McpHostAuthSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMcpConfig } from '../src/mcp/config-file.js';
import { createSettingsHarness, type SettingsHarness } from './mcp-settings-authority-harness.js';

const suno = parseConfiguredMcpServerId('suno');

/** A hosted server added by URL alone, as a user copies it from the server's docs. */
function config(entry: Record<string, unknown> = {}): string {
  return `{
  // keep this comment
  "servers": [
    ${JSON.stringify({
      name: 'suno',
      transport: 'streamable-http',
      url: 'https://mcp.example.test/mcp',
      ...entry,
    })}
  ]
}
`;
}

let harness: SettingsHarness | undefined;

async function started(content: string): Promise<SettingsHarness> {
  harness = await createSettingsHarness();
  await mkdir(path.dirname(harness.configPath), { recursive: true });
  await writeFile(harness.configPath, content, 'utf8');
  await harness.authority.start();
  return harness;
}

/** The server wants credentials it was not given, as the runtime reports it. */
function answeredUnauthorized(h: SettingsHarness, auth: McpHostAuthSnapshot = { type: 'none' }) {
  const server = h.publisher.snapshot().servers.find((s) => s.configuredServerId === suno);
  if (!server) {
    throw new Error('expected the configured server');
  }
  return h.publisher.publishActorTransition({ ...server, auth, state: 'authentication-required' })
    .servers[0];
}

afterEach(async () => {
  await harness?.authority.close().catch(() => undefined);
  await harness?.cleanup();
  harness = undefined;
});

describe('Connect on a server that asks for sign-in', () => {
  it('writes OAuth sign-in into its config entry, then connects the OAuth server', async () => {
    const h = await started(config());
    const refused = answeredUnauthorized(h);

    const connected = await h.authority.control({ action: 'connect', configuredServerId: suno });

    const text = await readFile(h.configPath, 'utf8');
    expect(text).toContain('// keep this comment');
    expect(parseMcpConfig(text).servers).toEqual([
      expect.objectContaining({
        auth: { type: 'oauth-user' },
        name: 'suno',
        startup: 'authentication-required',
      }),
    ]);
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ auth: { type: 'oauth-user' }, name: 'suno' })],
    });
    // The Connect reached the replaced OAuth server, not the one that answered 401.
    expect(connected.generation).toBeGreaterThan(refused?.generation ?? Number.POSITIVE_INFINITY);
  });

  it('drops an explicit automatic startup, which OAuth sign-in cannot keep', async () => {
    const h = await started(config({ startup: 'automatic' }));
    answeredUnauthorized(h);

    await h.authority.control({ action: 'connect', configuredServerId: suno });

    const [server] = parseMcpConfig(await readFile(h.configPath, 'utf8')).servers;
    expect(server).toMatchObject({
      auth: { type: 'oauth-user' },
      startup: 'authentication-required',
    });
  });

  it('leaves the config alone for a server already set up for OAuth', async () => {
    const original = config({ auth: { type: 'oauth-user' } });
    const h = await started(original);
    answeredUnauthorized(h, {
      credentialState: 'missing',
      grantedScopes: [],
      requestedScopes: [],
      resourceUrl: 'https://mcp.example.test/mcp',
      type: 'oauth-user',
    });

    await h.authority.control({ action: 'connect', configuredServerId: suno });

    await expect(readFile(h.configPath, 'utf8')).resolves.toBe(original);
    expect(h.control).toHaveBeenCalledWith({ action: 'connect', configuredServerId: suno });
  });

  it('refuses when the entry sends its own Authorization header, which the server rejected', async () => {
    const original = config({ headers: { Authorization: 'Bearer fixture-token' } });
    const h = await started(original);
    answeredUnauthorized(h);

    await expect(
      h.authority.control({ action: 'connect', configuredServerId: suno })
    ).rejects.toMatchObject({
      failure: { kind: 'refusal' },
      message: expect.stringContaining('Authorization header'),
    });
    await expect(readFile(h.configPath, 'utf8')).resolves.toBe(original);
    expect(h.control).not.toHaveBeenCalled();
  });
});
