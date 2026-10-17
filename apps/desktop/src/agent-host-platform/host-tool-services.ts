import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
/**
 * Main's side of the agent host's own tools: narrow typed reads of Main-owned
 * stores (`desktop-read/*`) and the worktree/forge correlation of host
 * commands. The agent host's admission decides which tools a run calls
 * (BST-1930 stage e); each request's own schema parses it here.
 */

import { SecretReadError } from '@brainstrike/agent-host/credential-contract';
import { ToolInputError } from '@brainstrike/assistant-contract';
import type { GrepSearchOptions, GrepSearchResult } from '@brainstrike/db';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { GitResult } from '@brainstrike/types';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import type { BrowserToolRunner } from '../assistant-server/native-tool-executors-browser';
import type { DiagnosticsReader } from '../assistant-server/query-diagnostics-core';
import type { RetrievalStore } from '../assistant-server/retrieval-store';
import {
  WORKTREE_TOOLS_UNAVAILABLE,
  type WorktreeToolCapability,
} from '../assistant-server/worktree-tools';
import { isActionableHostedEmbeddingError } from '../hosted-embedding-error';
import { attachHostCommandSessions } from './host-command-session-client';
import {
  DiagnosticsReadRequestSchema,
  GrepIndexRequestSchema,
  PlatformShellCompletedResultSchema,
  PlatformShellCompletedSchema,
  parseBrowserNavigateRequest,
  parseBrowserPageTextRequest,
  parseBrowserReadPageRequest,
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

const ThreadRequestSchema = Schema.Struct({ threadId: GrepIndexRequestSchema.fields.threadId });

/** Main's worktree/forge side of a host command, until the worktree ledger is a host fact. */
export interface DesktopShellCorrelation {
  /** Correlates the command and answers with the worktrees the ledger adopted from it. */
  readonly completed: (
    input: (typeof PlatformShellCompletedSchema)['Type']
  ) => Promise<(typeof PlatformShellCompletedResultSchema)['Type']['adopted']>;
  /** Every known worktree path before the command, or null without a worktree service. */
  readonly worktreePaths: () => Promise<readonly string[] | null>;
}

/** The Main-owned stores and services the host's tools read through Main. */
export interface HostToolServiceCapabilities {
  /** The window-bound browser pane's reads, driven in Main for a host run. */
  readonly browser?: BrowserToolRunner;
  /** The diagnostic events store, projected and scrubbed before a row leaves Main. */
  readonly diagnostics?: DiagnosticsReader;
  /** grep's indexed half over Main's PGlite file chunks. */
  readonly grepIndex?: (options: GrepSearchOptions) => Promise<GrepSearchResult>;
  /** Main's workspace index (search, grep, coverage); it stays Main-owned in M3. */
  readonly indexSearch?: IndexSearchCapability;
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
  connection.onRequest('platform/worktree/paths', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      wireDecoder(ThreadRequestSchema, { errors: 'all', onExcessProperty: 'error' })(input);
      return wireDecoder(WorktreePathsResultSchema, { errors: 'all', onExcessProperty: 'error' })({
        paths: services?.shell ? await services.shell.worktreePaths() : null,
      });
    })
  );
  connection.onRequest('platform/shell/completed', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const completed = wireDecoder(PlatformShellCompletedSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      return wireDecoder(PlatformShellCompletedResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })({
        adopted: services?.shell ? await services.shell.completed(completed) : [],
      });
    })
  );
  connection.onRequest('desktop-read/grep-index', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { options } = wireDecoder(GrepIndexRequestSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      return await required(services?.grepIndex, 'grep index')(options);
    })
  );
  // The Terminal panel reaches this host's command sessions over the same connection.
  attachHostCommandSessions(connection);
  serveIndexReads(connection, execute, services);
  serveWorktreeCalls(connection, execute, services);
  serveBrowserCalls(connection, execute, services);
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
      const { threadId } = wireDecoder(ThreadRequestSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      return await viaWorktrees(services?.worktrees?.({ runId: undefined, threadId }), (service) =>
        service.list()
      );
    })
  );
  connection.onRequest('platform/worktree/create', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { params, runId, threadId } = wireDecoder(WorktreeCreateRequestSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      return await viaWorktrees(services?.worktrees?.({ runId, threadId }), (service) =>
        service.create(params)
      );
    })
  );
  connection.onRequest('platform/worktree/archive', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { params, runId, threadId } = wireDecoder(WorktreeArchiveRequestSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
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
    (input) =>
      Schema.decodeUnknownSync(threadScoped(Schema.Record(Schema.String, Schema.Never)), {
        onExcessProperty: 'error',
      })(input),
    () => index().status()
  );
  read(
    'desktop-read/index/search',
    (input) =>
      Schema.decodeUnknownSync(threadScoped(IndexSearchRequestSchema), {
        errors: 'all',
        onExcessProperty: 'error',
      })(input),
    (request) => index().search(request)
  );
  read(
    'desktop-read/index/grep',
    (input) =>
      Schema.decodeUnknownSync(threadScoped(IndexGrepRequestSchema), {
        errors: 'all',
        onExcessProperty: 'error',
      })(input),
    (request) => index().grep(request)
  );
  read(
    'desktop-read/index/coverage',
    (input) =>
      Schema.decodeUnknownSync(threadScoped(IndexCoverageRequestSchema), {
        errors: 'all',
        onExcessProperty: 'error',
      })(input),
    (request) => index().coverage(request)
  );
  read(
    'desktop-read/index/coverage-batch',
    (input) =>
      Schema.decodeUnknownSync(
        threadScoped(Schema.mutable(Schema.Array(IndexCoverageRequestSchema))),
        {
          errors: 'all',
          onExcessProperty: 'error',
        }
      )(input),
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
        const { request } = Schema.decodeUnknownSync(
          threadScoped(
            Schema.Struct({ embeddingSetId: Schema.String.check(Schema.isMinCodePoints(1)) })
          ),
          { onExcessProperty: 'error' }
        )(input);
        return await refusalOutcome(() => store().embeddingSet(request.embeddingSetId));
      })
  );
  connection.onRequest(
    'desktop-read/retrieval/file-records',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { request } = Schema.decodeUnknownSync(
          threadScoped(
            Schema.Struct({
              ids: Schema.mutable(Schema.Array(Schema.String.check(Schema.isMinCodePoints(1)))),
            })
          ),
          { onExcessProperty: 'error' }
        )(input);
        return await refusalOutcome(async () => [
          ...(await store().fileRecords(request.ids)).values(),
        ]);
      })
  );
  connection.onRequest(
    'desktop-read/retrieval/embedding-spaces',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { request } = Schema.decodeUnknownSync(
          threadScoped(Schema.Struct({ includeStats: Schema.Boolean })),
          { onExcessProperty: 'error' }
        )(input);
        return await refusalOutcome(() => store().embeddingSpaces(request));
      })
  );
}
