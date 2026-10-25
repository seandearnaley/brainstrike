import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
/**
 * Main's root registry tells the live agent host which roots it disconnected,
 * over the platform connection Main serves, so the host stops the command
 * sessions and language servers it runs there. Without a connected host
 * nothing runs in any root.
 */
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { HostCommandSessionDisposeRootResultSchema } from './root-cleanup-wire';

let attached: MessageConnection | undefined;

export function attachHostRootCleanup(connection: MessageConnection): void {
  attached = connection;
  connection.onClose(() => {
    if (attached === connection) {
      attached = undefined;
    }
  });
}

/** Reap and forget the connected host's command sessions in a disconnected root. */
export async function disposeHostCommandSessionsForRoot(rootId: string): Promise<number> {
  if (!attached) {
    return 0;
  }
  return wireDecoder(HostCommandSessionDisposeRootResultSchema, { errors: 'all' })(
    await attached.sendRequest('host/command-sessions/dispose-root', { rootId })
  ).disposed;
}

/** End the connected host's language servers for a disconnected root. */
export async function evictHostLspServersForRoot(rootId: string): Promise<void> {
  if (!attached) {
    return;
  }
  wireDecoder(Schema.Null, { errors: 'all' })(
    await attached.sendRequest('host/lsp/evict-root', { rootId })
  );
}
