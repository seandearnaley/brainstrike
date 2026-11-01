import type { McpServerInput } from './mcp-config.ts';
import type { McpCredentialReferenceSchema } from './mcp-host.ts';

/**
 * Curated official remote MCP servers that Settings installs in one click
 * (docs/superpowers/specs/2026-10-18-mcp-catalog-design.md). Endpoints and auth
 * were verified against each vendor on 2026-10-18 (Suno on 2026-11-01);
 * re-verify before changing one.
 */
export const MCP_CATALOG_ACCESS = ['read-write', 'read-only'] as const;
export type McpCatalogAccess = (typeof MCP_CATALOG_ACCESS)[number];

export interface McpCatalogToken {
  /** Where the user creates the token the install asks for. */
  readonly createUrl: string;
  /** The kind of token, as the vendor names it. */
  readonly label: string;
}

interface McpCatalogEntryBase {
  readonly description: string;
  readonly docsUrl: string;
  /** The configured server name an install writes; also the catalog key. */
  readonly id: string;
  readonly name: string;
  /** `read-only` exists only where the vendor's server enforces it. */
  readonly urls: { readonly 'read-only'?: string; readonly 'read-write': string };
}

export type McpCatalogEntry =
  | (McpCatalogEntryBase & { readonly auth: 'oauth' })
  | (McpCatalogEntryBase & { readonly auth: 'token'; readonly token: McpCatalogToken });

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    auth: 'oauth',
    description: 'Issues, projects, cycles and documents in your Linear workspace.',
    docsUrl: 'https://linear.app/docs/mcp',
    id: 'linear',
    name: 'Linear',
    urls: {
      'read-only': 'https://mcp.linear.app/mcp/readonly',
      'read-write': 'https://mcp.linear.app/mcp',
    },
  },
  {
    auth: 'token',
    description: 'Repositories, issues, pull requests and Actions on github.com.',
    docsUrl: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
    id: 'github',
    name: 'GitHub',
    token: {
      createUrl: 'https://github.com/settings/personal-access-tokens/new',
      label: 'Fine-grained personal access token',
    },
    urls: {
      'read-only': 'https://api.githubcopilot.com/mcp/readonly',
      'read-write': 'https://api.githubcopilot.com/mcp/',
    },
  },
  {
    auth: 'oauth',
    description: 'Jira and Confluence on your Atlassian Cloud site.',
    docsUrl:
      'https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/',
    id: 'atlassian',
    name: 'Atlassian',
    urls: { 'read-write': 'https://mcp.atlassian.com/v2/mcp' },
  },
  {
    auth: 'oauth',
    description: 'Projects, merge requests, issues and pipelines on gitlab.com.',
    docsUrl: 'https://docs.gitlab.com/user/model_context_protocol/mcp_server/',
    id: 'gitlab',
    name: 'GitLab',
    urls: { 'read-write': 'https://gitlab.com/api/v4/mcp' },
  },
  {
    auth: 'oauth',
    description: 'Songs, covers, speech and playlists in your Suno library.',
    docsUrl: 'https://suno.com/mcp',
    id: 'suno',
    name: 'Suno',
    urls: { 'read-write': 'https://api.suno.com/mcp' },
  },
];

/** The stored-token reference a token entry's server carries, as the config grammar encodes it. */
export type McpCatalogCredentialReference = (typeof McpCredentialReferenceSchema)['Encoded'];

/** One install request from Settings; `token` only for a token entry. */
export interface McpCatalogInstallRequest {
  readonly access: McpCatalogAccess;
  readonly catalogId: string;
  readonly token?: string;
}

export function findMcpCatalogEntry(catalogId: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === catalogId);
}

/**
 * The catalog's install rules, stated once: the endpoint this access names, or
 * why `entry` cannot take this access or token.
 */
function catalogInstallEndpoint(
  entry: McpCatalogEntry,
  request: { readonly access: McpCatalogAccess; readonly hasToken: boolean }
): { readonly refusal: string } | { readonly url: string } {
  const url = entry.urls[request.access];
  if (url === undefined) {
    return { refusal: `${entry.name} has no ${request.access} endpoint.` };
  }
  if (entry.auth === 'oauth' && request.hasToken) {
    return { refusal: `${entry.name} signs in with OAuth and takes no token.` };
  }
  if (entry.auth === 'token' && !request.hasToken) {
    return { refusal: `${entry.name} needs a token.` };
  }
  return { url };
}

/** Why `entry` cannot take this access or token, or `undefined` when it can. */
export function mcpCatalogInstallRefusal(
  entry: McpCatalogEntry,
  request: { readonly access: McpCatalogAccess; readonly hasToken: boolean }
): string | undefined {
  const endpoint = catalogInstallEndpoint(entry, request);
  return 'refusal' in endpoint ? endpoint.refusal : undefined;
}

/**
 * The config server entry one catalog install appends. A token entry needs the
 * reference to its stored token; an OAuth entry takes none.
 */
export function mcpCatalogServerInput(
  entry: McpCatalogEntry,
  access: McpCatalogAccess,
  credential?: McpCatalogCredentialReference
): McpServerInput {
  const endpoint = catalogInstallEndpoint(entry, { access, hasToken: credential !== undefined });
  if ('refusal' in endpoint) {
    throw new Error(endpoint.refusal);
  }
  const target = {
    name: entry.id,
    protocol: 'auto',
    transport: 'streamable-http',
    url: endpoint.url,
  } as const;
  // The rules pair a credential with a token entry and none with an OAuth entry.
  if (credential === undefined) {
    return { auth: { type: 'oauth-user' }, ...target };
  }
  return {
    auth: { credential: { id: credential.id, store: credential.store }, type: 'bearer' },
    ...target,
  };
}
