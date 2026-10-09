/**
 * Main's side of the agent host's own tools: narrow typed reads of Main-owned
 * stores (`desktop-read/*`) and the worktree/forge correlation of host
 * commands. The agent host's admission decides which tools a run calls
 * (BST-1930 stage e); each request's own schema parses it here.
 */

import { ToolInputError } from '@brainstrike/assistant-contract';
import type { GrepSearchOptions, GrepSearchResult } from '@brainstrike/db';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { GitResult } from '@brainstrike/types';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import type { BrowserToolRunner } from '../assistant-server/native-tool-executors-browser';
import type { DiagnosticsReader } from '../assistant-server/query-diagnostics-core';
import { QUERY_SELF_ERROR_MESSAGES, type QuerySelfRead } from '../assistant-server/query-self-core';
import type { RetrievalStore } from '../assistant-server/retrieval-store';
import type { WorkspaceContextBroadcaster } from '../assistant-server/workspace-context-tools';
import {
  WORKTREE_TOOLS_UNAVAILABLE,
  type WorktreeToolCapability,
} from '../assistant-server/worktree-tools';
import { attachHostCommandSessions } from './host-command-session-client';
import {
  BrowserNavigateRequestSchema,
  BrowserPageTextRequestSchema,
  BrowserReadPageRequestSchema,
  ContextSelectionDeliveryRequestSchema,
  ContextTapestryDeliveryRequestSchema,
  DiagnosticsReadRequestSchema,
  GrepIndexRequestSchema,
  PlatformShellCompletedResultSchema,
  PlatformShellCompletedSchema,
  QuerySelfReadRequestSchema,
  WorktreeArchiveRequestSchema,
  WorktreeCreateRequestSchema,
  WorktreePathsResultSchema,
} from './host-tool-wire';
import {
  IndexCoverageRequestSchema,
  IndexGrepRequestSchema,
  IndexSearchRequestSchema,
  threadScoped,
} from './retrieval-wire';

const ThreadRequestSchema = GrepIndexRequestSchema.pick({ threadId: true });

/** Main's worktree/forge side of a host command, until the worktree ledger is a host fact. */
export interface DesktopShellCorrelation {
  /** Correlates the command and answers with the worktrees the ledger adopted from it. */
  readonly completed: (
    input: z.output<typeof PlatformShellCompletedSchema>
  ) => Promise<z.output<typeof PlatformShellCompletedResultSchema>['adopted']>;
  /** Every known worktree path before the command, or null without a worktree service. */
  readonly worktreePaths: () => Promise<readonly string[] | null>;
}

/** The Main-owned stores and services the host's tools read through Main. */
export interface HostToolServiceCapabilities {
  /** The window-bound browser pane's reads, driven in Main for a host run. */
  readonly browser?: BrowserToolRunner;
  /** Delivery of a host run's validated context write-back to the visible windows. */
  readonly contextDelivery?: WorkspaceContextBroadcaster;
  /** The diagnostic events store, projected and scrubbed before a row leaves Main. */
  readonly diagnostics?: DiagnosticsReader;
  /** grep's indexed half over Main's PGlite file chunks. */
  readonly grepIndex?: (options: GrepSearchOptions) => Promise<GrepSearchResult>;
  /** Main's workspace index (search, grep, coverage); it stays Main-owned in M3. */
  readonly indexSearch?: IndexSearchCapability;
  /** querySelf's SQL: the sandboxed application role or the read-only index process. */
  readonly querySelf?: QuerySelfRead;
  /** The retrieval catalog over Main's PGlite (embedding sets, file records, spaces). */
  readonly retrievalStore?: RetrievalStore;
  /** Worktree/forge correlation of host shell commands (BST-1392). */
  readonly shell?: DesktopShellCorrelation;
  /** Main's worktree service for host-thread worktree tools, under the host run's identity. */
  readonly worktrees?: (run: {
    readonly runId: string | undefined;
    readonly threadId: string;
  }) => WorktreeToolCapability | undefined;
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
  connection.onRequest('platform/worktree/paths', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      ThreadRequestSchema.parse(input);
      return WorktreePathsResultSchema.parse({
        paths: services?.shell ? await services.shell.worktreePaths() : null,
      });
    })
  );
  connection.onRequest('platform/shell/completed', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const completed = PlatformShellCompletedSchema.parse(input);
      return PlatformShellCompletedResultSchema.parse({
        adopted: services?.shell ? await services.shell.completed(completed) : [],
      });
    })
  );
  connection.onRequest('desktop-read/grep-index', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { options } = GrepIndexRequestSchema.parse(input);
      return await required(services?.grepIndex, 'grep index')(options);
    })
  );
  // The Terminal panel reaches this host's command sessions over the same connection.
  attachHostCommandSessions(connection);
  serveIndexReads(connection, execute, services);
  serveWorktreeCalls(connection, execute, services);
  serveBrowserCalls(connection, execute, services);
  serveContextDelivery(connection, execute, services);
  serveSelfInspectionReads(connection, execute, services);
  serveRetrievalReads(connection, execute, services);
}

/** Main's worktree service answers, or the stated reason it cannot in this session. */
async function viaWorktrees<T>(
  worktrees: WorktreeToolCapability | undefined,
  call: (service: WorktreeToolCapability) => Promise<GitResult<T>>
): Promise<GitResult<T>> {
  return worktrees ? await call(worktrees) : { error: WORKTREE_TOOLS_UNAVAILABLE, ok: false };
}

/** `platform/worktree/*`: Main's worktree service for a host thread, until the ledger moves. */
function serveWorktreeCalls(
  connection: MessageConnection,
  execute: Execute,
  services: HostToolServiceCapabilities | undefined
): void {
  connection.onRequest('platform/worktree/list', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { threadId } = ThreadRequestSchema.parse(input);
      return await viaWorktrees(services?.worktrees?.({ runId: undefined, threadId }), (service) =>
        service.list()
      );
    })
  );
  connection.onRequest('platform/worktree/create', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { params, runId, threadId } = WorktreeCreateRequestSchema.parse(input);
      return await viaWorktrees(services?.worktrees?.({ runId, threadId }), (service) =>
        service.create(params)
      );
    })
  );
  connection.onRequest('platform/worktree/archive', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { params, runId, threadId } = WorktreeArchiveRequestSchema.parse(input);
      return await viaWorktrees(services?.worktrees?.({ runId, threadId }), (service) =>
        service.archive(params)
      );
    })
  );
}

/** `platform/browser/*`: the active pane, which only Main's window can drive. */
function serveBrowserCalls(
  connection: MessageConnection,
  execute: Execute,
  services: HostToolServiceCapabilities | undefined
): void {
  connection.onRequest('platform/browser/navigate', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = BrowserNavigateRequestSchema.parse(input);
      return await required(services?.browser, 'browser pane').navigate(request.input);
    })
  );
  connection.onRequest('platform/browser/read-page', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = BrowserReadPageRequestSchema.parse(input);
      return await required(services?.browser, 'browser pane').readPage(request.input);
    })
  );
  connection.onRequest('platform/browser/page-text', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = BrowserPageTextRequestSchema.parse(input);
      return await required(services?.browser, 'browser pane').getPageText(request.input);
    })
  );
}

/** `platform/workspace-context/*`: only Main can reach the app windows. */
function serveContextDelivery(
  connection: MessageConnection,
  execute: Execute,
  services: HostToolServiceCapabilities | undefined
): void {
  connection.onRequest(
    'platform/workspace-context/selection',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { payload } = ContextSelectionDeliveryRequestSchema.parse(input);
        const delivery = required(services?.contextDelivery, 'window delivery');
        return { notifiedWindowCount: await delivery.selection(payload) };
      })
  );
  connection.onRequest(
    'platform/workspace-context/tapestry',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { payload } = ContextTapestryDeliveryRequestSchema.parse(input);
        const delivery = required(services?.contextDelivery, 'window delivery');
        return { notifiedWindowCount: await delivery.tapestry(payload) };
      })
  );
}

/** The model-facing outcome of Main's querySelf read; anything else (a cancelled index query) rejects. */
async function querySelfOutcome(read: QuerySelfRead, ...args: Parameters<QuerySelfRead>) {
  try {
    return { ok: true as const, result: await read(...args) };
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { error: 'input' as const, message: error.message, ok: false as const };
    }
    if (error instanceof Error && error.message === QUERY_SELF_ERROR_MESSAGES.queryFailed) {
      return { error: 'failed' as const, ok: false as const };
    }
    throw error;
  }
}

/** `desktop-read/query-self` and `desktop-read/diagnostics/*`: Main's own databases. */
function serveSelfInspectionReads(
  connection: MessageConnection,
  execute: Execute,
  services: HostToolServiceCapabilities | undefined
): void {
  connection.onRequest('desktop-read/query-self', (input: unknown, token: CancellationToken) =>
    execute(token, async (signal) => {
      const { request } = QuerySelfReadRequestSchema.parse(input);
      return await querySelfOutcome(
        required(services?.querySelf, 'self-query read'),
        request,
        signal
      );
    })
  );
  connection.onRequest(
    'desktop-read/diagnostics/events',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { filter } = DiagnosticsReadRequestSchema.parse(input);
        return await required(services?.diagnostics, 'diagnostics store').events(filter);
      })
  );
  connection.onRequest(
    'desktop-read/diagnostics/fingerprints',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { filter } = DiagnosticsReadRequestSchema.parse(input);
        return await required(services?.diagnostics, 'diagnostics store').fingerprints(filter);
      })
  );
}

/** `desktop-read/index/*`: Main's IndexSearchCapability, read for a host thread. */
function serveIndexReads(
  connection: MessageConnection,
  execute: Execute,
  services: HostToolServiceCapabilities | undefined
): void {
  const index = () => required(services?.indexSearch, 'workspace index');
  /** One read: parse the thread-scoped request, check admission, answer from Main's index. */
  const read = <R>(
    method: string,
    parse: (input: unknown) => { readonly request: R; readonly threadId: string },
    perform: (request: R) => Promise<unknown>
  ): void => {
    connection.onRequest(method, (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { request } = parse(input);
        return await perform(request);
      })
    );
  };
  read(
    'desktop-read/index/status',
    (input) => threadScoped(z.strictObject({})).parse(input),
    () => index().status()
  );
  read(
    'desktop-read/index/search',
    (input) => threadScoped(IndexSearchRequestSchema).parse(input),
    (request) => index().search(request)
  );
  read(
    'desktop-read/index/grep',
    (input) => threadScoped(IndexGrepRequestSchema).parse(input),
    (request) => index().grep(request)
  );
  read(
    'desktop-read/index/coverage',
    (input) => threadScoped(IndexCoverageRequestSchema).parse(input),
    (request) => index().coverage(request)
  );
  read(
    'desktop-read/index/coverage-batch',
    (input) => threadScoped(z.array(IndexCoverageRequestSchema)).parse(input),
    (requests) => index().coverageBatch(requests)
  );
}

/** `desktop-read/retrieval/*` and the renderer query embedding, for a host thread. */
function serveRetrievalReads(
  connection: MessageConnection,
  execute: Execute,
  services: HostToolServiceCapabilities | undefined
): void {
  const store = () => required(services?.retrievalStore, 'retrieval catalog');
  connection.onRequest(
    'desktop-read/retrieval/embedding-set',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { request } = threadScoped(
          z.strictObject({ embeddingSetId: z.string().min(1) })
        ).parse(input);
        return await store().embeddingSet(request.embeddingSetId);
      })
  );
  connection.onRequest(
    'desktop-read/retrieval/file-records',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { request } = threadScoped(z.strictObject({ ids: z.array(z.string().min(1)) })).parse(
          input
        );
        return [...(await store().fileRecords(request.ids)).values()];
      })
  );
  connection.onRequest(
    'desktop-read/retrieval/embedding-spaces',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { request } = threadScoped(z.strictObject({ includeStats: z.boolean() })).parse(
          input
        );
        return await store().embeddingSpaces(request);
      })
  );
}
