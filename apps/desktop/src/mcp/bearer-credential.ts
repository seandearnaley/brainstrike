import type { ExplicitHttpMcpFetch } from '@brainstrike/agent/mcp-client';
import type { SecretsService } from '../secrets';

const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/u;

export interface McpBearerCredentialReference {
  readonly id: string;
  readonly store: 'mcp-credentials';
}

export type McpBearerCredentialState = 'missing' | 'stored' | 'unreadable';

export interface McpBearerCredentialAuthority {
  createFetch(reference: McpBearerCredentialReference, resourceUrl: string): ExplicitHttpMcpFetch;
  inspect(reference: McpBearerCredentialReference): Promise<{
    readonly state: McpBearerCredentialState;
  }>;
}

export type McpBearerCredentialFailureCode =
  | 'mcp-bearer-authorization-conflict'
  | 'mcp-bearer-credential-missing'
  | 'mcp-bearer-credential-unreadable'
  | 'mcp-bearer-origin-mismatch';

const FAILURE_MESSAGES = {
  'mcp-bearer-authorization-conflict':
    'MCP bearer authentication conflicts with transport authorization',
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
      code === 'mcp-bearer-credential-missing' || code === 'mcp-bearer-credential-unreadable'
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
  secrets: Pick<SecretsService, 'getKey'>,
  baseFetch: ExplicitHttpMcpFetch = async (input, init) => await fetch(input, init)
): McpBearerCredentialAuthority {
  const resolve = async (reference: McpBearerCredentialReference): Promise<string> => {
    let credential: string | null;
    try {
      credential = await secrets.getKey(mcpBearerCredentialStorageKey(reference));
    } catch {
      throw new McpBearerCredentialFailure('mcp-bearer-credential-unreadable');
    }
    if (credential === null) {
      throw new McpBearerCredentialFailure('mcp-bearer-credential-missing');
    }
    if (!isBearerToken(credential)) {
      throw new McpBearerCredentialFailure('mcp-bearer-credential-unreadable');
    }
    return credential;
  };

  return {
    createFetch(reference, resourceUrl) {
      const allowedOrigin = new URL(resourceUrl).origin;
      return async (input, init) => {
        if (requestOrigin(input) !== allowedOrigin) {
          throw new McpBearerCredentialFailure('mcp-bearer-origin-mismatch');
        }
        const headers = new Headers(init?.headers);
        if (headers.has('authorization')) {
          throw new McpBearerCredentialFailure('mcp-bearer-authorization-conflict');
        }
        const credential = await resolve(reference);
        headers.set('authorization', `Bearer ${credential}`);
        return await baseFetch(input, { ...init, headers });
      };
    },
    async inspect(reference) {
      try {
        await resolve(reference);
        return { state: 'stored' };
      } catch (error) {
        if (
          error instanceof McpBearerCredentialFailure &&
          error.code === 'mcp-bearer-credential-missing'
        ) {
          return { state: 'missing' };
        }
        return { state: 'unreadable' };
      }
    },
  };
}
