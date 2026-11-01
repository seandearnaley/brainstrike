import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
/**
 * Main's side of the agent host's own tools: narrow typed reads of Main-owned
 * stores (`desktop-read/*`) and the window-bound browser pane. The agent
 * host's admission decides which tools a run calls
 * (BST-1930 stage e); each request's own schema parses it here.
 */

import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import type { MainBrowserToolRunner } from '../assistant-server/browser-agent-tools';
import type { DiagnosticsReader } from '../assistant-server/query-diagnostics-core';
import {
  DiagnosticsReadRequestSchema,
  parseBrowserClickRequest,
  parseBrowserNavigateRequest,
  parseBrowserPageTextRequest,
  parseBrowserReadPageRequest,
  parseBrowserSelectOptionRequest,
  parseBrowserTypeRequest,
} from './host-tool-wire';
import { IndexSearchRequestSchema, threadScoped } from './retrieval-wire';

/** The Main-owned stores and services the host's tools read through Main. */
export interface HostToolServiceCapabilities {
  /** The window-bound browser's pages, driven in Main for a host run's thread. */
  readonly browser?: MainBrowserToolRunner;
  /** The diagnostic events store, projected and scrubbed before a row leaves Main. */
  readonly diagnostics?: DiagnosticsReader;
  /** Main's workspace text index, which `workspace/search` reads. */
  readonly indexSearch?: IndexSearchCapability;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Main has no ${what} for host threads`);
  }
  return value;
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
  serveIndexReads(connection, execute, services);
  serveBrowserCalls(connection, execute, services);
  serveSelfInspectionReads(connection, execute, services);
}

/** `platform/browser/*`: the run thread's pages, which only Main's window can drive. */
function serveBrowserCalls(
  connection: MessageConnection,
  execute: Execute,
  services: HostToolServiceCapabilities | undefined
): void {
  connection.onRequest('platform/browser/navigate', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = parseBrowserNavigateRequest(input);
      return await required(services?.browser, 'browser pane').navigate(
        request.input,
        request.threadId
      );
    })
  );
  connection.onRequest('platform/browser/read-page', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = parseBrowserReadPageRequest(input);
      return await required(services?.browser, 'browser pane').readPage(
        request.input,
        request.threadId
      );
    })
  );
  connection.onRequest('platform/browser/page-text', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = parseBrowserPageTextRequest(input);
      return await required(services?.browser, 'browser pane').getPageText(
        request.input,
        request.threadId
      );
    })
  );
  // BST-2324: the acting tools. The host admitted each call (access mode and
  // approval) before it got here; Main still re-parses the input.
  connection.onRequest('platform/browser/click', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = parseBrowserClickRequest(input);
      return await required(services?.browser, 'browser pane').click(
        request.input,
        request.threadId
      );
    })
  );
  connection.onRequest('platform/browser/type', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = parseBrowserTypeRequest(input);
      return await required(services?.browser, 'browser pane').type(
        request.input,
        request.threadId
      );
    })
  );
  connection.onRequest(
    'platform/browser/select-option',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const request = parseBrowserSelectOptionRequest(input);
        return await required(services?.browser, 'browser pane').selectOption(
          request.input,
          request.threadId
        );
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

/** `desktop-read/index/search`: Main's text index, searched for a host thread's `workspace/search`. */
function serveIndexReads(
  connection: MessageConnection,
  execute: Execute,
  services: HostToolServiceCapabilities | undefined
): void {
  connection.onRequest('desktop-read/index/search', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { request } = Schema.decodeUnknownSync(threadScoped(IndexSearchRequestSchema), {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      return await required(services?.indexSearch, 'workspace index').search(request);
    })
  );
}
