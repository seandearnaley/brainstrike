import { describe, expect, it } from 'vitest';
import {
  findMcpCatalogEntry,
  MCP_CATALOG,
  MCP_CATALOG_ACCESS,
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
  it('lists Linear, GitHub, Atlassian and GitLab once each, by valid server name', () => {
    expect(MCP_CATALOG.map(({ id }) => id)).toEqual(['linear', 'github', 'atlassian', 'gitlab']);
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
      'Linear signs in with OAuth and takes no token'
    );
    expect(() => mcpCatalogServerInput(entry('github'), 'read-write')).toThrow(
      'GitHub needs a stored token'
    );
    expect(() => mcpCatalogServerInput(entry('gitlab'), 'read-only')).toThrow(
      'GitLab has no read-only endpoint'
    );
    expect(findMcpCatalogEntry('jira')).toBeUndefined();
  });
});
