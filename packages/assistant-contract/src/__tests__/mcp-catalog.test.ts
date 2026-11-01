import { describe, expect, it } from 'vitest';
import {
  findMcpCatalogEntry,
  MCP_CATALOG,
  MCP_CATALOG_ACCESS,
  mcpCatalogInstallRefusal,
  mcpCatalogServerInput,
} from '../mcp-catalog.js';
import { parseMcpServerValue } from '../mcp-config.js';
import { parseConfiguredMcpServerId } from '../mcp-host.js';

const REFERENCE = { id: '00000000-0000-4000-8000-000000000001', store: 'mcp-credentials' } as const;

function entry(id: string) {
  const found = findMcpCatalogEntry(id);
  if (!found) {
    throw new Error(`catalog entry ${id} is missing`);
  }
  return found;
}

describe('MCP catalog', () => {
  it('lists Linear, GitHub, Atlassian, GitLab and Suno once each, by valid server name', () => {
    expect(MCP_CATALOG.map(({ id }) => id)).toEqual([
      'linear',
      'github',
      'atlassian',
      'gitlab',
      'suno',
    ]);
    for (const { id } of MCP_CATALOG) {
      expect(parseConfiguredMcpServerId(id)).toBe(id);
    }
  });

  it('builds a server entry the config grammar accepts for every offered access', () => {
    for (const catalogEntry of MCP_CATALOG) {
      for (const access of MCP_CATALOG_ACCESS) {
        const url = catalogEntry.urls[access];
        if (url === undefined) {
          continue;
        }
        const credential = catalogEntry.auth === 'token' ? REFERENCE : undefined;
        const server = parseMcpServerValue(mcpCatalogServerInput(catalogEntry, access, credential));
        expect(server).toMatchObject({
          name: catalogEntry.id,
          protocol: 'auto',
          transport: 'streamable-http',
          url,
        });
        expect(server.startup).toBe(
          catalogEntry.auth === 'oauth' ? 'authentication-required' : 'automatic'
        );
      }
    }
  });

  it('offers read-only only where the vendor server enforces it', () => {
    expect(
      MCP_CATALOG.filter(({ urls }) => urls['read-only'] !== undefined).map(({ id }) => id)
    ).toEqual(['linear', 'github']);
  });

  it('writes a token entry as a bearer reference, never as a header', () => {
    expect(mcpCatalogServerInput(entry('github'), 'read-only', REFERENCE)).toEqual({
      auth: { credential: REFERENCE, type: 'bearer' },
      name: 'github',
      protocol: 'auto',
      transport: 'streamable-http',
      url: 'https://api.githubcopilot.com/mcp/readonly',
    });
  });

  it('refuses a build that does not match the entry', () => {
    expect(() => mcpCatalogServerInput(entry('linear'), 'read-write', REFERENCE)).toThrow(
      /^Linear signs in with OAuth and takes no token\.$/u
    );
    expect(() => mcpCatalogServerInput(entry('github'), 'read-write')).toThrow(
      /^GitHub needs a token\.$/u
    );
    expect(() => mcpCatalogServerInput(entry('gitlab'), 'read-only')).toThrow(
      /^GitLab has no read-only endpoint\.$/u
    );
    expect(findMcpCatalogEntry('jira')).toBeUndefined();
  });

  it('names why a request does not fit its entry, endpoint first', () => {
    const refusals = MCP_CATALOG.flatMap((catalogEntry) =>
      MCP_CATALOG_ACCESS.flatMap((access) =>
        [false, true].map((hasToken) => [
          catalogEntry.id,
          access,
          hasToken,
          mcpCatalogInstallRefusal(catalogEntry, { access, hasToken }),
        ])
      )
    );
    expect(refusals).toEqual([
      ['linear', 'read-write', false, undefined],
      ['linear', 'read-write', true, 'Linear signs in with OAuth and takes no token.'],
      ['linear', 'read-only', false, undefined],
      ['linear', 'read-only', true, 'Linear signs in with OAuth and takes no token.'],
      ['github', 'read-write', false, 'GitHub needs a token.'],
      ['github', 'read-write', true, undefined],
      ['github', 'read-only', false, 'GitHub needs a token.'],
      ['github', 'read-only', true, undefined],
      ['atlassian', 'read-write', false, undefined],
      ['atlassian', 'read-write', true, 'Atlassian signs in with OAuth and takes no token.'],
      ['atlassian', 'read-only', false, 'Atlassian has no read-only endpoint.'],
      ['atlassian', 'read-only', true, 'Atlassian has no read-only endpoint.'],
      ['gitlab', 'read-write', false, undefined],
      ['gitlab', 'read-write', true, 'GitLab signs in with OAuth and takes no token.'],
      ['gitlab', 'read-only', false, 'GitLab has no read-only endpoint.'],
      ['gitlab', 'read-only', true, 'GitLab has no read-only endpoint.'],
      ['suno', 'read-write', false, undefined],
      ['suno', 'read-write', true, 'Suno signs in with OAuth and takes no token.'],
      ['suno', 'read-only', false, 'Suno has no read-only endpoint.'],
      ['suno', 'read-only', true, 'Suno has no read-only endpoint.'],
    ]);
  });
});
