import { type McpHostServerSnapshot, refusalError } from '@brainstrike/assistant-contract';
import { applyEdits, type FormattingOptions, modify } from 'jsonc-parser';
import type { McpConfigCommit } from './catalog-install.ts';
import { type McpConfigFile, parseMcpConfig } from './config-file.ts';
import { syncFailureError } from './config-sync.ts';

const CONFIG_FORMATTING: FormattingOptions = { eol: '\n', insertSpaces: true, tabSize: 2 };

/**
 * Whether a 401 answering this server's Connect is an OAuth sign-in: a streamable
 * HTTP server configured without auth. Under MCP authorization the server's
 * challenge, not the config, says it wants a user's sign-in, and other MCP
 * clients start OAuth from it. Without this, Connect re-dials unsigned and gets
 * the same 401 every time.
 */
export function connectSignsInWithOAuth(server: McpHostServerSnapshot | undefined): boolean {
  return server?.transport === 'streamable-http' && server.auth?.type === 'none';
}

/** The runtime's answer to a dial the server refused with 401. */
export function isAuthenticationRequired(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'mcp-authentication-required';
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
 * An explicit `"startup": "automatic"` goes, since OAuth waits for the user. An
 * entry that sends its own Authorization header is refused: the server rejected
 * that header, and an OAuth grant cannot be combined with it.
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
  // The 401 came from the config the runtime loaded. An edit saved since then
  // that sets auth or changes the transport is the user's newer choice.
  if (
    entry.transport !== 'streamable-http' ||
    (entry.auth !== undefined && entry.auth.type !== 'none')
  ) {
    throw refusalError(
      'conflict',
      'mcp.oauth-sign-in-config-changed',
      `The MCP config for ${serverName} changed after it asked for sign-in, so nothing was changed. Connect again once the new config has loaded.`
    );
  }
  if (Object.keys(entry.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')) {
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
  const signedIn = edit(document.content, 'auth', { type: 'oauth-user' });
  // An `automatic` startup cannot stay beside OAuth. Without auth it is the
  // default, so removing it is no edit when the entry never wrote it.
  const content = entry.startup === 'automatic' ? edit(signedIn, 'startup', undefined) : signedIn;
  const { result, syncFailure } = await commit(
    content,
    document.revision,
    `The MCP config changed while signing in to ${serverName}; nothing was changed. Try again.`
  );
  if (syncFailure !== undefined) {
    throw syncFailureError(result, syncFailure);
  }
  if (!result.success) {
    throw result.conflict
      ? refusalError('conflict', 'mcp.oauth-sign-in-conflict', result.error)
      : new Error(result.error);
  }
}
