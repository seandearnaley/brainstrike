import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type McpHostAuthSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMcpConfig } from '../src/mcp/config-file.js';
import { createSettingsHarness, type SettingsHarness } from './mcp-settings-authority-harness.js';

const suno = parseConfiguredMcpServerId('suno');
const CONNECT = { action: 'connect', configuredServerId: suno } as const;
const OAUTH_AUTH: McpHostAuthSnapshot = {
  credentialState: 'missing',
  grantedScopes: [],
  requestedScopes: [],
  resourceUrl: 'https://mcp.example.test/mcp',
  type: 'oauth-user',
};

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

/** The configured server rests in authentication-required with `auth` as the runtime projects it. */
async function started(
  content: string,
  auth: McpHostAuthSnapshot = { type: 'none' }
): Promise<{ readonly generation: number | undefined; readonly h: SettingsHarness }> {
  harness = await createSettingsHarness();
  await mkdir(path.dirname(harness.configPath), { recursive: true });
  await writeFile(harness.configPath, content, 'utf8');
  await harness.authority.start();
  const server = harness.publisher.snapshot().servers.find((s) => s.configuredServerId === suno);
  if (!server) {
    throw new Error('expected the configured server');
  }
  const resting = harness.publisher.publishActorTransition({
    ...server,
    auth,
    state: 'authentication-required',
  });
  return { generation: resting.servers[0]?.generation, h: harness };
}

/** The Connect's dial reaches the server, which answers 401, as the runtime reports it. */
function answers401(h: SettingsHarness): void {
  h.control.mockRejectedValueOnce(
    Object.assign(
      new Error(
        'MCP authentication required. Connect or reauthorize this server in Settings > AI Tools.'
      ),
      { category: 'authentication', code: 'mcp-authentication-required' }
    )
  );
}

afterEach(async () => {
  await harness?.authority.close().catch(() => undefined);
  await harness?.cleanup();
  harness = undefined;
});

describe('Connect on a server added without auth', () => {
  it('signs in once the server answers 401: OAuth goes into its entry, then the OAuth server connects', async () => {
    const { generation, h } = await started(config());
    answers401(h);

    const connected = await h.authority.control(CONNECT);

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
    // The second Connect reached the replaced OAuth server, not the one that answered 401.
    expect(connected.generation).toBeGreaterThan(generation ?? Number.POSITIVE_INFINITY);
  });

  it('drops an explicit automatic startup, which OAuth sign-in cannot keep', async () => {
    const { h } = await started(config({ startup: 'automatic' }));
    answers401(h);

    await h.authority.control(CONNECT);

    const text = await readFile(h.configPath, 'utf8');
    expect(text).not.toContain('"startup"');
    expect(parseMcpConfig(text).servers).toEqual([
      expect.objectContaining({ auth: { type: 'oauth-user' }, startup: 'authentication-required' }),
    ]);
  });

  it('signs in an on-demand server that answers 401 and keeps its startup', async () => {
    const { h } = await started(config({ startup: 'authentication-required' }));
    answers401(h);

    await h.authority.control(CONNECT);

    const text = await readFile(h.configPath, 'utf8');
    expect(text).toMatch(/"startup":\s*"authentication-required"/u);
    expect(parseMcpConfig(text).servers).toEqual([
      expect.objectContaining({ auth: { type: 'oauth-user' }, startup: 'authentication-required' }),
    ]);
  });

  it('leaves an on-demand server that connects without credentials as written', async () => {
    const original = config({ startup: 'authentication-required' });
    const { h } = await started(original);

    await h.authority.control(CONNECT);

    await expect(readFile(h.configPath, 'utf8')).resolves.toBe(original);
    expect(h.control).toHaveBeenCalledOnce();
  });

  it('shows the 401 of a server already set up for OAuth as it came, and changes nothing', async () => {
    const original = config({ auth: { type: 'oauth-user' } });
    const { h } = await started(original, OAUTH_AUTH);
    answers401(h);

    await expect(h.authority.control(CONNECT)).rejects.toMatchObject({
      code: 'mcp-authentication-required',
    });
    await expect(readFile(h.configPath, 'utf8')).resolves.toBe(original);
    expect(h.control).toHaveBeenCalledOnce();
  });

  it('refuses as a conflict when the file changes between its read and the write', async () => {
    const { h } = await started(config());
    answers401(h);
    vi.spyOn(h.configFile, 'writeText').mockResolvedValueOnce({
      conflict: true,
      error: 'The MCP config changed on disk since it was read.',
      path: h.configPath,
      success: false,
    });

    await expect(h.authority.control(CONNECT)).rejects.toMatchObject({
      failure: { category: 'conflict', kind: 'refusal' },
    });
    expect(h.control).toHaveBeenCalledOnce();
  });

  it('refuses when the entry sends its own Authorization header, which the server rejected', async () => {
    const original = config({ headers: { Authorization: 'Bearer fixture-token' } });
    const { h } = await started(original);
    answers401(h);

    await expect(h.authority.control(CONNECT)).rejects.toMatchObject({
      failure: { kind: 'refusal' },
      message: expect.stringContaining('Authorization header'),
    });
    await expect(readFile(h.configPath, 'utf8')).resolves.toBe(original);
    expect(h.control).toHaveBeenCalledOnce();
  });

  it('keeps auth the user saved on disk after the 401, before the watcher reloaded it', async () => {
    const { h } = await started(config());
    answers401(h);
    const edited = config({ auth: { scopes: ['read'], type: 'oauth-user' } });
    // Saved in another editor; the watcher has not delivered the change yet.
    await writeFile(h.configPath, edited, 'utf8');

    await expect(h.authority.control(CONNECT)).rejects.toMatchObject({
      failure: { category: 'conflict', kind: 'refusal' },
    });
    await expect(readFile(h.configPath, 'utf8')).resolves.toBe(edited);
    expect(h.control).toHaveBeenCalledOnce();
  });
});
