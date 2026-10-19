import type { HostParams } from '@brainstrike/agent-host';
import {
  findMcpCatalogEntry,
  type McpCatalogEntry,
  mcpCatalogInstallRefusal,
  mcpCatalogServerInput,
} from '@brainstrike/assistant-contract/mcp-catalog';
import { applyEdits, type FormattingOptions, modify } from 'jsonc-parser';
import type {
  McpBearerCredentialReference,
  McpBearerCredentialWriter,
} from './bearer-credential.js';
import {
  errorMessage,
  type McpConfigFile,
  type McpConfigWriteResult,
  parseMcpConfig,
} from './config-file.js';
import { type McpConfigWriteSync, syncFailureError } from './config-sync.js';

const CONFIG_FORMATTING: FormattingOptions = { eol: '\n', insertSpaces: true, tabSize: 2 };

/**
 * The settings authority's config write on its current lifecycle: writes
 * `content` while the file still has `baseRevision`, then syncs the runtime.
 * `conflictMessage` words a stale base.
 *
 * It rejects only when nothing was written, and returns every failure after a
 * write as `syncFailure` beside the write's result. A config watcher that
 * cannot stop or restart is neither: it is config status's `watchError`. The install's
 * token rollback depends on this, since a rejection deletes the token.
 */
export type McpConfigCommit = (
  content: string,
  baseRevision: string,
  conflictMessage: string
) => Promise<McpConfigWriteSync>;

/** One catalog install: the request, and what the authority lends it. */
export interface McpCatalogInstall {
  /** The one writer of the `mcp-credentials` tokens a catalog install stores. */
  readonly bearerCredentials: McpBearerCredentialWriter;
  readonly commit: McpConfigCommit;
  readonly configFile: McpConfigFile;
  readonly request: HostParams<'mcp/config/install'>;
}

/**
 * Appends one catalog server to the config (spec 2026-10-18 §4.2) on the
 * revision it read. A token entry stores its token first and removes it
 * again unless the config file was written, since a written file references it.
 */
export async function installCatalogServerWith({
  bearerCredentials,
  commit,
  configFile,
  request,
}: McpCatalogInstall): Promise<McpConfigWriteResult> {
  const configPath = await configFile.path();
  const refuse = (error: string): McpConfigWriteResult => ({
    error,
    path: configPath,
    success: false,
  });
  const entry = findMcpCatalogEntry(request.catalogId);
  if (!entry) {
    return refuse(`Unknown MCP catalog entry "${request.catalogId}".`);
  }
  const mismatch = mcpCatalogInstallRefusal(entry, {
    access: request.access,
    hasToken: request.token !== undefined,
  });
  if (mismatch !== undefined) {
    return refuse(mismatch);
  }
  const document = await configFile.readText(true);
  if (document.error !== undefined) {
    return refuse(`Fix the MCP config before installing ${entry.name}: ${document.error}`);
  }
  if (parseMcpConfig(document.content).servers.some(({ name }) => name === entry.id)) {
    return refuse(`An MCP server named "${entry.id}" is already configured.`);
  }
  let credential: McpBearerCredentialReference | undefined;
  if (request.token !== undefined) {
    try {
      credential = await bearerCredentials.create(request.token);
    } catch (error) {
      return refuse(`${entry.name} token was not stored: ${errorMessage(error)}`);
    }
  }
  const server = mcpCatalogServerInput(entry, request.access, credential);
  const content = applyEdits(
    document.content,
    modify(document.content, ['servers', -1], server, { formattingOptions: CONFIG_FORMATTING })
  );
  return await commitInstallText(
    { bearerCredentials, commit },
    entry,
    credential,
    content,
    document.revision
  );
}

/**
 * Commits an install's config text. The stored token stays only once the file
 * that references it was written (`commit` resolved a successful result): a
 * refused or failed write, or a `commit` that rejects because nothing was
 * written, removes the token and reports a failed removal. A written file that
 * then cannot be reloaded rejects as a partial success: the server was added.
 */
async function commitInstallText(
  { bearerCredentials, commit }: Pick<McpCatalogInstall, 'bearerCredentials' | 'commit'>,
  entry: McpCatalogEntry,
  credential: McpBearerCredentialReference | undefined,
  content: string,
  baseRevision: string
): Promise<McpConfigWriteResult> {
  let committed: McpConfigWriteSync;
  try {
    committed = await commit(
      content,
      baseRevision,
      `The MCP config changed while installing ${entry.name}; nothing was installed. Try again.`
    );
  } catch (error) {
    if (credential === undefined) {
      throw error;
    }
    const removalFailure = await removeUnwrittenToken(bearerCredentials, entry, credential);
    throw new Error(`${errorMessage(error)}; ${tokenRemovalNote(entry, removalFailure)}`, {
      cause: error,
    });
  }
  const { result, syncFailure } = committed;
  if (result.success) {
    if (syncFailure === undefined) {
      return result;
    }
    throw new Error(
      `${entry.name} was added to the MCP config, but ${syncFailure.step}: ${errorMessage(syncFailure.error)}`,
      { cause: syncFailure.error }
    );
  }
  if (credential === undefined) {
    if (syncFailure !== undefined) {
      throw syncFailureError(result, syncFailure);
    }
    return result;
  }
  const removalFailure = await removeUnwrittenToken(bearerCredentials, entry, credential);
  if (syncFailure !== undefined) {
    throw syncFailureError(result, syncFailure, tokenRemovalNote(entry, removalFailure));
  }
  return removalFailure === undefined
    ? result
    : { ...result, error: `${result.error}; ${removalFailure}` };
}

/** How removing the stored token went, for a failure that reports it. */
function tokenRemovalNote(entry: McpCatalogEntry, removalFailure: string | undefined): string {
  return removalFailure ?? `the stored ${entry.name} token was removed`;
}

/** Removes a token no written config references: `undefined`, or why it could not be. */
async function removeUnwrittenToken(
  bearerCredentials: McpBearerCredentialWriter,
  entry: McpCatalogEntry,
  credential: McpBearerCredentialReference
): Promise<string | undefined> {
  try {
    await bearerCredentials.delete(credential);
    return undefined;
  } catch (error) {
    return `the stored ${entry.name} token could not be removed: ${errorMessage(error)}`;
  }
}
