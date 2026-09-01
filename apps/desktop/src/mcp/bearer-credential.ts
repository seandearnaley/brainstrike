import type { ExplicitHttpMcpFetch } from '@brainstrike/agent/mcp-client';
import type { SecretsService } from '../secrets';

const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/u;

export interface McpBearerCredentialReference {
  readonly id: string;
  readonly store: 'mcp-credentials';
}

export type McpBearerCredentialState = 'malformed' | 'missing' | 'stored' | 'unreadable';

export interface McpBearerCredentialAuthority {
  createFetch(
    reference: McpBearerCredentialReference,
    resourceUrl: string,
    onStateChanged?: (state: McpBearerCredentialState) => void
  ): ExplicitHttpMcpFetch;
  inspect(reference: McpBearerCredentialReference): Promise<{
    readonly state: McpBearerCredentialState;
  }>;
}

export type McpBearerCredentialFailureCode =
  | 'mcp-bearer-authorization-conflict'
  | 'mcp-bearer-credential-malformed'
  | 'mcp-bearer-credential-missing'
  | 'mcp-bearer-credential-unreadable'
  | 'mcp-bearer-origin-mismatch';

const FAILURE_MESSAGES = {
  'mcp-bearer-authorization-conflict':
    'MCP bearer authentication conflicts with transport authorization',
  'mcp-bearer-credential-malformed': 'MCP bearer credential is malformed',
  'mcp-bearer-credential-missing': 'MCP bearer credential is missing',
  'mcp-bearer-credential-unreadable': 'MCP bearer credential is unreadable',
  'mcp-bearer-origin-mismatch': 'MCP bearer credential cannot be sent to another origin',
} satisfies Record<McpBearerCredentialFailureCode, string>;

export class McpBearerCredentialFailure extends Error {
  readonly category: 'authentication' | 'configuration';
  readonly code: McpBearerCredentialFailureCode;

  constructor(code: McpBearerCredentialFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = 'McpBearerCredentialFailure';
    this.code = code;
    this.category =
      code === 'mcp-bearer-credential-malformed' ||
      code === 'mcp-bearer-credential-missing' ||
      code === 'mcp-bearer-credential-unreadable'
        ? 'authentication'
        : 'configuration';
  }
}

export function mcpBearerCredentialStorageKey(reference: McpBearerCredentialReference): string {
  return `${reference.store}:${reference.id}`;
}

function isBearerToken(value: string): boolean {
  return BEARER_TOKEN_PATTERN.test(value);
}

function requestOrigin(input: string | URL): string {
  try {
    return new URL(input).origin;
  } catch {
    throw new McpBearerCredentialFailure('mcp-bearer-origin-mismatch');
  }
}

export function createSecretsMcpBearerCredentialAuthority(
  secrets: Pick<SecretsService, 'getKey' | 'listProviders'>,
  baseFetch: ExplicitHttpMcpFetch = async (input, init) => await fetch(input, init)
): McpBearerCredentialAuthority {
  const resolve = async (
    reference: McpBearerCredentialReference,
    onStateChanged?: (state: McpBearerCredentialState) => void
  ): Promise<string> => {
    let credential: string | null;
    try {
      credential = await secrets.getKey(mcpBearerCredentialStorageKey(reference));
    } catch {
      onStateChanged?.('unreadable');
      throw new McpBearerCredentialFailure('mcp-bearer-credential-unreadable');
    }
    if (credential === null) {
      onStateChanged?.('missing');
      throw new McpBearerCredentialFailure('mcp-bearer-credential-missing');
    }
    if (!isBearerToken(credential)) {
      onStateChanged?.('malformed');
      throw new McpBearerCredentialFailure('mcp-bearer-credential-malformed');
    }
    onStateChanged?.('stored');
    return credential;
  };

  return {
    createFetch(reference, resourceUrl, onStateChanged) {
      const allowedOrigin = requestOrigin(resourceUrl);
      return async (input, init) => {
        if (requestOrigin(input) !== allowedOrigin) {
          throw new McpBearerCredentialFailure('mcp-bearer-origin-mismatch');
        }
        const headers = new Headers(init?.headers);
        if (headers.has('authorization')) {
          throw new McpBearerCredentialFailure('mcp-bearer-authorization-conflict');
        }
        const credential = await resolve(reference, onStateChanged);
        headers.set('authorization', `Bearer ${credential}`);
        return await baseFetch(input, { ...init, headers });
      };
    },
    async inspect(reference) {
      try {
        const storageKey = mcpBearerCredentialStorageKey(reference);
        const providers = await secrets.listProviders();
        return { state: providers.includes(storageKey) ? 'stored' : 'missing' };
      } catch {
        return { state: 'unreadable' };
      }
    },
  };
}
