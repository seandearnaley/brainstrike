/**
 * Main's side of the agent host's own tools: narrow typed reads of Main-owned
 * stores (`desktop-read/*`) and the worktree/forge correlation of host
 * commands. Each request is served only for a thread Main has admitted.
 */
import type { GrepSearchOptions, GrepSearchResult } from '@brainstrike/db';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import type { z } from 'zod';
import {
  GrepIndexRequestSchema,
  PlatformShellCompletedSchema,
  WorktreePathsResultSchema,
} from './host-tool-wire';

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
  /** Worktree/forge correlation of host shell commands (BST-1392). */
  readonly shell?: DesktopShellCorrelation;
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
      if (!services?.grepIndex) {
        throw new Error('Main has no grep index for host threads');
      }
      return await services.grepIndex(options);
    })
  );
}
