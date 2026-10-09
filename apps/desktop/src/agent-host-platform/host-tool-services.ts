/**
 * Main's side of the agent host's own tools: narrow typed reads of Main-owned
 * stores (`desktop-read/*`) and the worktree/forge correlation of host
 * commands. Each request is served only for a thread Main has admitted.
 */
import type { GrepSearchOptions, GrepSearchResult } from '@brainstrike/db';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import type { RetrievalStore } from '../assistant-server/retrieval-store';
import {
  GrepIndexRequestSchema,
  PlatformShellCompletedSchema,
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
  readonly completed: (input: z.output<typeof PlatformShellCompletedSchema>) => void;
  /** Every known worktree path before the command, or null without a worktree service. */
  readonly worktreePaths: () => Promise<readonly string[] | null>;
}

/** The Main-owned stores and services the host's tools read through Main. */
export interface HostToolServiceCapabilities {
  /** grep's indexed half over Main's PGlite file chunks. */
  readonly grepIndex?: (options: GrepSearchOptions) => Promise<GrepSearchResult>;
  /** Main's workspace index (search, grep, coverage); it stays Main-owned in M3. */
  readonly indexSearch?: IndexSearchCapability;
  /** The retrieval catalog over Main's PGlite (embedding sets, file records, spaces). */
  readonly retrievalStore?: RetrievalStore;
  /** Worktree/forge correlation of host shell commands (BST-1392). */
  readonly shell?: DesktopShellCorrelation;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Main has no ${what} for host threads`);
  }
  return value;
}

type Execute = <T>(
  token: CancellationToken,
  work: (signal: AbortSignal) => Promise<T>
) => Promise<T>;

/** Register Main's handlers; `admitted` throws for a thread without admitted capabilities. */
export function serveHostToolServices(
  connection: MessageConnection,
  execute: Execute,
  admitted: (threadId: string) => unknown,
  services: HostToolServiceCapabilities | undefined
): void {
  connection.onRequest('platform/worktree/paths', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      admitted(ThreadRequestSchema.parse(input).threadId);
      return WorktreePathsResultSchema.parse({
        paths: services?.shell ? await services.shell.worktreePaths() : null,
      });
    })
  );
  connection.onRequest('platform/shell/completed', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const completed = PlatformShellCompletedSchema.parse(input);
      admitted(completed.threadId);
      services?.shell?.completed(completed);
      return { accepted: true };
    })
  );
  connection.onRequest('desktop-read/grep-index', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const { options, threadId } = GrepIndexRequestSchema.parse(input);
      admitted(threadId);
      return await required(services?.grepIndex, 'grep index')(options);
    })
  );
  serveIndexReads(connection, execute, admitted, services);
  serveRetrievalReads(connection, execute, admitted, services);
}

/** `desktop-read/index/*`: Main's IndexSearchCapability, read for an admitted thread. */
function serveIndexReads(
  connection: MessageConnection,
  execute: Execute,
  admitted: (threadId: string) => unknown,
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
        const { request, threadId } = parse(input);
        admitted(threadId);
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

/** `desktop-read/retrieval/*` and the renderer query embedding, for an admitted thread. */
function serveRetrievalReads(
  connection: MessageConnection,
  execute: Execute,
  admitted: (threadId: string) => unknown,
  services: HostToolServiceCapabilities | undefined
): void {
  const store = () => required(services?.retrievalStore, 'retrieval catalog');
  connection.onRequest(
    'desktop-read/retrieval/embedding-set',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { request, threadId } = threadScoped(
          z.strictObject({ embeddingSetId: z.string().min(1) })
        ).parse(input);
        admitted(threadId);
        return await store().embeddingSet(request.embeddingSetId);
      })
  );
  connection.onRequest(
    'desktop-read/retrieval/file-records',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { request, threadId } = threadScoped(
          z.strictObject({ ids: z.array(z.string().min(1)) })
        ).parse(input);
        admitted(threadId);
        return [...(await store().fileRecords(request.ids)).values()];
      })
  );
  connection.onRequest(
    'desktop-read/retrieval/embedding-spaces',
    (input: unknown, token: CancellationToken) =>
      execute(token, async () => {
        const { request, threadId } = threadScoped(
          z.strictObject({ includeStats: z.boolean() })
        ).parse(input);
        admitted(threadId);
        return await store().embeddingSpaces(request);
      })
  );
}
