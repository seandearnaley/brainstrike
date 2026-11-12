/**
 * ADR-0015, ADR-0034: before Factory Reset deletes the state DB that holds the worktree ledger,
 * Main asks the host it launched to archive every managed worktree. The archive forces past
 * ignored files and leaves the worktree service making no worktree, so only Main may ask: it
 * travels on Main's private platform connection, as Main's MCP retire for the reset does
 * (`mcp-runtime/settings/reset`). No window holds that connection, and the desktop's client
 * connection, which windows and Main's own client share, has no such method.
 */
import { BoundaryFailureSchema, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import type { WorktreeResetArchive } from '@brainstrike/types';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';

/** Main to the host it launched, on the platform connection only. */
export const FACTORY_RESET_WORKTREES_ARCHIVE_METHOD = 'factory-reset/worktrees/archive';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const ResetArchiveAnswerSchema = Schema.Union(
  [
    Schema.Struct({
      ok: Schema.Literal(true),
      value: Schema.Struct({
        archived: Schema.Array(Schema.Struct({ path: Id, snapshotRef: Id, worktreeId: Id })),
        retained: Schema.Array(
          Schema.Struct({ code: Id, path: Id, reason: Schema.String, worktreeId: Id })
        ),
      }),
    }),
    Schema.Struct({ error: BoundaryFailureSchema, ok: Schema.Literal(false) }),
  ],
  { mode: 'oneOf' }
);
const decodeAnswer = wireDecoder(ResetArchiveAnswerSchema, {
  errors: 'all',
  onExcessProperty: 'error',
});
const decodeNoParams = wireDecoder(Schema.Record(Schema.String, Schema.Never), {
  errors: 'all',
  onExcessProperty: 'error',
});

const HOST_NOT_READY = refusal({
  category: 'availability',
  code: 'host.not-ready',
  message:
    'The agent host this app launched is not ready, so its managed worktrees could not be archived.',
});

/** The host's side: answers Main's request with its git cluster's archive. */
export function serveWorktreeResetToMain(
  connection: Pick<MessageConnection, 'onRequest'>,
  archive: () => Promise<BoundaryResult<WorktreeResetArchive>>
): { close(): void } {
  const handler = connection.onRequest(
    FACTORY_RESET_WORKTREES_ARCHIVE_METHOD,
    (input: unknown): Promise<unknown> => {
      decodeNoParams(input);
      return archive();
    }
  );
  return { close: () => handler.dispose() };
}

export interface MainWorktreeReset {
  /** Factory Reset: the ready host archives every managed worktree; refused when none is. */
  archive(): Promise<BoundaryResult<WorktreeResetArchive>>;
  /**
   * Main's platform serving of one host connection. It answers once the host has confirmed
   * Main ready (`platform/ready`), after its git cluster is composed, until the connection closes.
   */
  bind(connection: MessageConnection): { close(): void; ready(): void };
}

export function createMainWorktreeReset(): MainWorktreeReset {
  let ready: MessageConnection | undefined;
  return {
    archive: async () => {
      if (!ready) {
        return { error: HOST_NOT_READY, ok: false };
      }
      return decodeAnswer(await ready.sendRequest(FACTORY_RESET_WORKTREES_ARCHIVE_METHOD, {}));
    },
    bind: (connection) => {
      let bound = true;
      return {
        close: () => {
          bound = false;
          if (ready === connection) {
            ready = undefined;
          }
        },
        ready: () => {
          if (bound) {
            ready = connection;
          }
        },
      };
    },
  };
}
