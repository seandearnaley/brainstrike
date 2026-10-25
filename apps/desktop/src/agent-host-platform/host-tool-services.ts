import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
/**
 * Main's side of the agent host's own tools: Main's diagnostics store
 * (`desktop-read/diagnostics/*`) and the window-bound browser pane. The agent
 * host's admission decides which tools a run calls
 * (BST-1930 stage e); each request's own schema parses it here.
 */

import { SecretReadError } from '@brainstrike/agent-host/credential-contract';
import { ToolInputError } from '@brainstrike/assistant-contract';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import type { BrowserToolRunner } from '../assistant-server/native-tool-executors-browser';
import type { DiagnosticsReader } from '../assistant-server/query-diagnostics-core';
import { isActionableHostedEmbeddingError } from '../hosted-embedding-error';
import {
  DiagnosticsReadRequestSchema,
  parseBrowserNavigateRequest,
  parseBrowserPageTextRequest,
  parseBrowserReadPageRequest,
} from './host-tool-wire';

/** The Main-owned stores and services the host's tools read through Main. */
export interface HostToolServiceCapabilities {
  /** The window-bound browser pane's reads, driven in Main for a host run. */
  readonly browser?: BrowserToolRunner;
  /** The diagnostic events store, projected and scrubbed before a row leaves Main. */
  readonly diagnostics?: DiagnosticsReader;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Main has no ${what} for host threads`);
  }
  return value;
}

/**
 * BST-1996: a read's result, or the refusal Main raised in it, as the data the
 * host raises again as a ToolInputError (`RefusableOutcomeSchema`). A refusal
 * is decided by type, never by message text (BST-1985): a ToolInputError, a
 * stored key the user must repair, or an actionable hosted embedding refusal.
 * Any other fault rejects, and the host keeps it redacted.
 */
export async function refusalOutcome<T>(
  read: () => Promise<T>
): Promise<
  { readonly ok: true; readonly result: T } | { readonly message: string; readonly ok: false }
> {
  try {
    return { ok: true as const, result: await read() };
  } catch (error) {
    if (
      error instanceof ToolInputError ||
      error instanceof SecretReadError ||
      isActionableHostedEmbeddingError(error)
    ) {
      return { message: error.message, ok: false as const };
    }
    throw error;
  }
}

/** Main's cancellable execution; a result crosses as JSON that the host parses. */
type Execute = (
  token: CancellationToken,
  work: (signal: AbortSignal) => Promise<unknown>
) => Promise<unknown>;

/** Register Main's handlers for the agent host's own tools. */
export function serveHostToolServices(
  connection: MessageConnection,
  execute: Execute,
  services: HostToolServiceCapabilities | undefined
): void {
  serveBrowserCalls(connection, execute, services);
  serveSelfInspectionReads(connection, execute, services);
}

/** `platform/browser/*`: the active pane, which only Main's window can drive. */
function serveBrowserCalls(
  connection: MessageConnection,
  execute: Execute,
  services: HostToolServiceCapabilities | undefined
): void {
  connection.onRequest('platform/browser/navigate', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = parseBrowserNavigateRequest(input);
      return await required(services?.browser, 'browser pane').navigate(request.input);
    })
  );
  connection.onRequest('platform/browser/read-page', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = parseBrowserReadPageRequest(input);
      return await required(services?.browser, 'browser pane').readPage(request.input);
    })
  );
  connection.onRequest('platform/browser/page-text', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = parseBrowserPageTextRequest(input);
      return await required(services?.browser, 'browser pane').getPageText(request.input);
    })
  );
}

/** `desktop-read/diagnostics/*`: Main's own diagnostics store. */
function serveSelfInspectionReads(
  connection: MessageConnection,
  execute: Execute,
  services: HostToolServiceCapabilities | undefined
): void {
  connection.onRequest(
    'desktop-read/diagnostics/events',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { filter } = wireDecoder(DiagnosticsReadRequestSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        return await required(services?.diagnostics, 'diagnostics store').events(filter);
      })
  );
  connection.onRequest(
    'desktop-read/diagnostics/fingerprints',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { filter } = wireDecoder(DiagnosticsReadRequestSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        return await required(services?.diagnostics, 'diagnostics store').fingerprints(filter);
      })
  );
}
