import { type McpHostServerSnapshot, refusalError } from '@brainstrike/assistant-contract';
import { applyEdits, type FormattingOptions, modify } from 'jsonc-parser';
import type { McpConfigCommit } from './catalog-install.ts';
import { type McpConfigFile, parseMcpConfig } from './config-file.ts';
import { syncFailureError } from './config-sync.ts';

const CONFIG_FORMATTING: FormattingOptions = { eol: '\n', insertSpaces: true, tabSize: 2 };

/**
 * Whether a Connect on this server is an OAuth sign-in: a streamable HTTP
 * server configured without auth answered 401. Under MCP authorization the
 * server's challenge, not the config, says it wants a user's sign-in, and other
 * MCP clients start OAuth from it. Without this, Connect re-dials unsigned and
 * gets the same 401 every time.
 */
export function connectSignsInWithOAuth(server: McpHostServerSnapshot | undefined): boolean {
  return (
    server?.state === 'authentication-required' &&
    server.transport === 'streamable-http' &&
    server.auth?.type === 'none'
  );
}

/** One OAuth sign-in: the server to sign in to, and what the authority lends it. */
export interface McpOAuthSignIn {
  readonly commit: McpConfigCommit;
  readonly configFile: McpConfigFile;
  readonly serverName: string;
}

/**
 * Writes `"auth": { "type": "oauth-user" }` into the server's config entry on the
 * revision it read, and syncs the runtime. The config stays the one writer of a
 * server's auth mode: the reload replaces the server with an OAuth one, whose
 * Connect opens the browser, and later launches reconnect with its stored grant.
 * Its `startup` goes, since OAuth waits for the user. An entry that
 * sends its own Authorization header is refused: the server rejected that header,
 * and an OAuth grant cannot be combined with it.
 */
export async function signInWithOAuthWith({
  commit,
  configFile,
  serverName,
}: McpOAuthSignIn): Promise<void> {
  const document = await configFile.readText(true);
  if (document.error !== undefined) {
    throw refusalError(
      'configuration',
      'mcp.oauth-sign-in-config-invalid',
      `Fix the MCP config before signing in to ${serverName}: ${document.error}`
    );
  }
  const servers = parseMcpConfig(document.content).servers;
  const index = servers.findIndex(({ name }) => name === serverName);
  const entry = servers[index];
  if (entry === undefined) {
    throw refusalError(
      'conflict',
      'mcp.oauth-sign-in-server-missing',
      `The MCP config no longer has a server named "${serverName}".`
    );
  }
  if (
    entry.transport !== 'stdio' &&
    Object.keys(entry.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
  ) {
    throw refusalError(
      'configuration',
      'mcp.oauth-sign-in-authorization-header',
      `${serverName} refused the Authorization header in its MCP config entry. Update that header, or remove it to sign in with OAuth.`
    );
  }
  const edit = (text: string, key: string, value: unknown): string =>
    applyEdits(
      text,
      modify(text, ['servers', index, key], value, { formattingOptions: CONFIG_FORMATTING })
    );
  // Removing an absent `startup` is no edit; an `authentication-required` one
  // is what OAuth resolves to anyway.
  const content = edit(
    edit(document.content, 'auth', { type: 'oauth-user' }),
    'startup',
    undefined
  );
  const { result, syncFailure } = await commit(
    content,
    document.revision,
    `The MCP config changed while signing in to ${serverName}; nothing was changed. Try again.`
  );
  if (syncFailure !== undefined) {
    throw syncFailureError(result, syncFailure);
  }
  if (!result.success) {
    throw new Error(result.error);
  }
}
