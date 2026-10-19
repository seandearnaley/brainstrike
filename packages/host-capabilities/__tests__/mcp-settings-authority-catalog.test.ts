import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpBearerCredentialReference } from '../src/mcp/bearer-credential.js';
import { mcpConfigRevision } from '../src/mcp/config-file.js';
import {
  createSettingsHarness,
  type SettingsHarness,
  stdioServer,
} from './mcp-settings-authority-harness.js';

const COMMENTED = `{
  // keep this comment
  "servers": [
    // and this one
  ]
}
`;
const TOKEN = 'github_pat_fixture0123456789';
const EXTERNAL = `${JSON.stringify({ servers: [stdioServer('external')] })}\n`;
const GITHUB_CONFLICT =
  'The MCP config changed while installing GitHub; nothing was installed. Try again.';

/** The config changes on disk while the token is stored, as during a keychain prompt. */
function editWhileStoringToken(h: SettingsHarness): void {
  const create = h.bearer.writer.create.getMockImplementation();
  if (!create) {
    throw new Error('The harness token store has no implementation');
  }
  h.bearer.writer.create.mockImplementationOnce(
    async (token: string): Promise<McpBearerCredentialReference> => {
      const reference = await create(token);
      await writeFile(h.configPath, EXTERNAL, 'utf8');
      return reference;
    }
  );
}

let harness: SettingsHarness | undefined;

async function started(content = COMMENTED): Promise<SettingsHarness> {
  harness = await createSettingsHarness();
  await mkdir(path.dirname(harness.configPath), { recursive: true });
  await writeFile(harness.configPath, content, 'utf8');
  await harness.authority.start();
  return harness;
}

afterEach(async () => {
  await harness?.authority.close().catch(() => undefined);
  await harness?.cleanup();
  harness = undefined;
});

describe('MCP catalog install', () => {
  it('appends the OAuth server, keeps the comments and commits it to the runtime', async () => {
    const h = await started();

    const result = await h.authority.installCatalogServer({
      access: 'read-only',
      catalogId: 'linear',
    });

    const text = await readFile(h.configPath, 'utf8');
    expect(result).toEqual({
      path: h.configPath,
      revision: mcpConfigRevision(text),
      success: true,
    });
    expect(text).toContain('// keep this comment');
    expect(text).toContain('// and this one');
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [
        expect.objectContaining({
          auth: { type: 'oauth-user' },
          name: 'linear',
          startup: 'authentication-required',
          url: 'https://mcp.linear.app/mcp/readonly',
        }),
      ],
    });
    expect(h.bearer.writer.create).not.toHaveBeenCalled();
  });

  it('stores a token entry and writes only its reference to the file', async () => {
    const h = await started();

    const result = await h.authority.installCatalogServer({
      access: 'read-write',
      catalogId: 'github',
      token: TOKEN,
    });

    const text = await readFile(h.configPath, 'utf8');
    expect(result).toEqual({
      path: h.configPath,
      revision: mcpConfigRevision(text),
      success: true,
    });
    expect(text).not.toContain(TOKEN);
    const [stored] = [...h.bearer.stored];
    expect(stored?.[1]).toBe(TOKEN);
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [
        expect.objectContaining({
          auth: { credential: { id: stored?.[0], store: 'mcp-credentials' }, type: 'bearer' },
          name: 'github',
          url: 'https://api.githubcopilot.com/mcp/',
        }),
      ],
    });
  });

  it('refuses a server name that is already configured and leaves the file untouched', async () => {
    const existing = JSON.stringify({
      servers: [
        {
          auth: { type: 'oauth-user' },
          name: 'linear',
          protocol: 'auto',
          transport: 'streamable-http',
          url: 'https://mcp.linear.app/mcp',
        },
      ],
    });
    const h = await started(existing);

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'linear' })
    ).resolves.toEqual({
      error: 'An MCP server named "linear" is already configured.',
      path: h.configPath,
      success: false,
    });
    expect(await readFile(h.configPath, 'utf8')).toBe(existing);
  });

  it('refuses while the config does not parse and never overwrites it', async () => {
    const broken = '{ "servers": [ { "name": "x" ';
    const h = await started(broken);

    const result = await h.authority.installCatalogServer({
      access: 'read-write',
      catalogId: 'gitlab',
    });

    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error).toMatch(
      /^Fix the MCP config before installing GitLab: invalid_mcp_config/u
    );
    expect(await readFile(h.configPath, 'utf8')).toBe(broken);
  });

  it('refuses a token install for a configured name before storing the token', async () => {
    const existing = JSON.stringify({ servers: [stdioServer('github')] });
    const h = await started(existing);

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).resolves.toEqual({
      error: 'An MCP server named "github" is already configured.',
      path: h.configPath,
      success: false,
    });
    expect(h.bearer.writer.create).not.toHaveBeenCalled();
    expect(h.bearer.stored.size).toBe(0);
    expect(await readFile(h.configPath, 'utf8')).toBe(existing);
  });

  it('refuses a token install while the config does not parse, before storing the token', async () => {
    const broken = '{ "servers": [ { "name": "x" ';
    const h = await started(broken);

    const result = await h.authority.installCatalogServer({
      access: 'read-write',
      catalogId: 'github',
      token: TOKEN,
    });

    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error).toMatch(
      /^Fix the MCP config before installing GitHub: invalid_mcp_config/u
    );
    expect(h.bearer.writer.create).not.toHaveBeenCalled();
    expect(h.bearer.stored.size).toBe(0);
    expect(await readFile(h.configPath, 'utf8')).toBe(broken);
  });

  it('refuses mismatched requests before touching the token store or the file', async () => {
    const h = await started();
    const refused = (error: string) => ({ error, path: h.configPath, success: false });

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'jira' })
    ).resolves.toEqual(refused('Unknown MCP catalog entry "jira".'));
    await expect(
      h.authority.installCatalogServer({ access: 'read-only', catalogId: 'gitlab' })
    ).resolves.toEqual(refused('GitLab has no read-only endpoint.'));
    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'linear', token: TOKEN })
    ).resolves.toEqual(refused('Linear signs in with OAuth and takes no token.'));
    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github' })
    ).resolves.toEqual(refused('GitHub needs a token.'));
    expect(h.bearer.writer.create).not.toHaveBeenCalled();
    expect(await readFile(h.configPath, 'utf8')).toBe(COMMENTED);
  });

  it('reports a token the store refuses and leaves the file untouched', async () => {
    const h = await started();
    h.bearer.writer.create.mockRejectedValueOnce(new Error('MCP bearer credential is malformed'));

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).resolves.toEqual({
      error: 'GitHub token was not stored: MCP bearer credential is malformed',
      path: h.configPath,
      success: false,
    });
    expect(await readFile(h.configPath, 'utf8')).toBe(COMMENTED);
  });

  it('removes the stored token when the config write fails', async () => {
    const h = await started();
    vi.spyOn(h.configFile, 'writeText').mockResolvedValueOnce({
      error: 'disk full',
      path: h.configPath,
      success: false,
    });

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).resolves.toEqual({ error: 'disk full', path: h.configPath, success: false });
    expect(h.bearer.writer.delete).toHaveBeenCalledOnce();
    expect(h.bearer.stored.size).toBe(0);
  });

  it('removes the stored token when the config write throws before writing', async () => {
    const h = await started();
    const writeFailure = new Error('EACCES: permission denied');
    vi.spyOn(h.configFile, 'writeText').mockRejectedValueOnce(writeFailure);

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).rejects.toMatchObject({
      cause: writeFailure,
      message: 'EACCES: permission denied; the stored GitHub token was removed',
    });
    expect(h.bearer.writer.delete).toHaveBeenCalledOnce();
    expect(h.bearer.stored.size).toBe(0);
    expect(await readFile(h.configPath, 'utf8')).toBe(COMMENTED);
  });

  it('reports both failures when the token cannot be removed after a thrown write', async () => {
    const h = await started();
    const writeFailure = new Error('EACCES: permission denied');
    vi.spyOn(h.configFile, 'writeText').mockRejectedValueOnce(writeFailure);
    h.bearer.writer.delete.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).rejects.toMatchObject({
      cause: writeFailure,
      message:
        'EACCES: permission denied; the stored GitHub token could not be removed: keychain locked',
    });
  });

  it('keeps the stored token and says it was added when the written config cannot be reloaded', async () => {
    const h = await started();
    const reloadFailure = new Error('EIO: i/o error, read');
    vi.spyOn(h.configFile, 'load').mockRejectedValueOnce(reloadFailure);

    const error = await h.authority
      .installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
      .then(
        () => undefined,
        (failure: unknown) => failure
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'GitHub was added to the MCP config, but the MCP config could not be reloaded: EIO: i/o error, read'
    );
    expect((error as Error).cause).toBe(reloadFailure);
    expect(h.configFile.load).toHaveBeenCalledOnce();
    expect(h.bearer.writer.delete).not.toHaveBeenCalled();
    expect(h.bearer.stored.size).toBe(1);
    const [id] = h.bearer.stored.keys();
    expect(id).toBeDefined();
    expect(await readFile(h.configPath, 'utf8')).toContain(`"id": "${id}"`);
  });

  it('says an OAuth install was added when the written config cannot be reloaded', async () => {
    const h = await started();
    const reloadFailure = new Error('EIO: i/o error, read');
    vi.spyOn(h.configFile, 'load').mockRejectedValueOnce(reloadFailure);

    const error = await h.authority
      .installCatalogServer({ access: 'read-only', catalogId: 'linear' })
      .then(
        () => undefined,
        (failure: unknown) => failure
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Linear was added to the MCP config, but the MCP config could not be reloaded: EIO: i/o error, read'
    );
    expect((error as Error).cause).toBe(reloadFailure);
    expect(await readFile(h.configPath, 'utf8')).toContain('"name": "linear"');
  });

  it('installs, keeps its token and reports watchError when the watcher cannot restart', async () => {
    const h = await started();
    vi.mocked(h.configFile.watch).mockRejectedValueOnce(new Error('watch failed'));

    const result = await h.authority.installCatalogServer({
      access: 'read-write',
      catalogId: 'github',
      token: TOKEN,
    });

    const text = await readFile(h.configPath, 'utf8');
    expect(result).toEqual({
      path: h.configPath,
      revision: mcpConfigRevision(text),
      success: true,
    });
    expect(h.bearer.writer.delete).not.toHaveBeenCalled();
    const [id] = h.bearer.stored.keys();
    expect(text).toContain(`"id": "${id}"`);
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'github' })],
    });
    expect(h.events.findLast(({ type }) => type === 'config')).toEqual({
      config: expect.objectContaining({ watchError: 'watch failed' }),
      type: 'config',
    });
  });

  it('reports both failures when the token cannot be removed after a failed write', async () => {
    const h = await started();
    vi.spyOn(h.configFile, 'writeText').mockResolvedValueOnce({
      error: 'disk full',
      path: h.configPath,
      success: false,
    });
    h.bearer.writer.delete.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).resolves.toEqual({
      error: 'disk full; the stored GitHub token could not be removed: keychain locked',
      path: h.configPath,
      success: false,
    });
  });
  it('refuses an install when the config changes while its token is stored, and removes the token', async () => {
    const h = await started();
    editWhileStoringToken(h);

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).resolves.toEqual({
      conflict: true,
      error: GITHUB_CONFLICT,
      path: h.configPath,
      success: false,
    });
    expect(h.bearer.writer.delete).toHaveBeenCalledOnce();
    expect(h.bearer.stored.size).toBe(0);
    expect(await readFile(h.configPath, 'utf8')).toBe(EXTERNAL);
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'external' })],
    });
  });

  it('reports both failures when a conflicted install cannot remove its token', async () => {
    const h = await started();
    editWhileStoringToken(h);
    h.bearer.writer.delete.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).resolves.toEqual({
      conflict: true,
      error: `${GITHUB_CONFLICT}; the stored GitHub token could not be removed: keychain locked`,
      path: h.configPath,
      success: false,
    });
    expect(await readFile(h.configPath, 'utf8')).toBe(EXTERNAL);
  });

  it('refuses an OAuth install when the config changes after it was read', async () => {
    const h = await started();
    const readText = h.configFile.readText;
    vi.spyOn(h.configFile, 'readText').mockImplementationOnce(async (createIfMissing) => {
      const document = await readText(createIfMissing);
      await writeFile(h.configPath, EXTERNAL, 'utf8');
      return document;
    });

    await expect(
      h.authority.installCatalogServer({ access: 'read-only', catalogId: 'linear' })
    ).resolves.toEqual({
      conflict: true,
      error: 'The MCP config changed while installing Linear; nothing was installed. Try again.',
      path: h.configPath,
      success: false,
    });
    expect(await readFile(h.configPath, 'utf8')).toBe(EXTERNAL);
  });

  it('removes the token of a refused write and reloads the changed file when the watcher then cannot restart', async () => {
    const h = await started();
    editWhileStoringToken(h);
    vi.mocked(h.configFile.watch).mockRejectedValueOnce(new Error('watch failed'));

    await expect(
      h.authority.installCatalogServer({ access: 'read-write', catalogId: 'github', token: TOKEN })
    ).resolves.toEqual({
      conflict: true,
      error: GITHUB_CONFLICT,
      path: h.configPath,
      success: false,
    });
    expect(h.bearer.writer.delete).toHaveBeenCalledOnce();
    expect(h.bearer.stored.size).toBe(0);
    expect(await readFile(h.configPath, 'utf8')).toBe(EXTERNAL);
    expect(h.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [expect.objectContaining({ name: 'external' })],
    });
    await expect(h.authority.configStatus()).resolves.toMatchObject({ watchError: 'watch failed' });
  });
});
