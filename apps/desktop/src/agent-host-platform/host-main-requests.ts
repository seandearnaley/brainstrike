import { toBoundaryResponseError } from '@brainstrike/agent-host/boundary-wire';
import { WORKSPACE_FILES_RESULT_SCHEMAS } from '@brainstrike/agent-host/protocol';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { createLogger } from '@brainstrike/logging';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { DesktopWorkspaceRoots } from './desktop-workspace-roots';
import {
  HOST_FOLDERS_ADD_PICKED,
  HOST_FOLDERS_RECENT_PATHS,
  HostFoldersAddPickedSchema,
} from './host-folders-wire';
import { HOST_INDEX_EMBEDDING_STOP } from './host-index-wire';

const logger = createLogger('HostMainRequests');
const strict = { errors: 'all', onExcessProperty: 'error' } as const;
const decodePicked = wireDecoder(HostFoldersAddPickedSchema, strict);
const decodeNone = wireDecoder(Schema.Record(Schema.String, Schema.Never), strict);
const wireFolder = wireDecoder(WORKSPACE_FILES_RESULT_SCHEMAS['files/add-root-by-path'], {
  errors: 'all',
});

/**
 * What Main asks of this host over the platform connection: the folder its dialog picked, the
 * File menu's recents, and its embedding Stop. A typed refusal reaches Main as itself.
 */
export function serveMainRequests(
  connection: MessageConnection,
  owners: {
    readonly embeddingStop: () => Promise<void>;
    readonly folders: DesktopWorkspaceRoots;
  }
): void {
  const serve = (method: string, handler: (input: unknown) => Promise<unknown>): void => {
    connection.onRequest(method, (input: unknown) =>
      handler(input).catch((cause: unknown) => {
        throw toBoundaryResponseError(cause, (message, fields) =>
          logger.error(message, { ...fields, method })
        );
      })
    );
  };
  serve(HOST_FOLDERS_ADD_PICKED, async (input) =>
    wireFolder(await owners.folders.roots.addRoot(decodePicked(input).handle))
  );
  serve(HOST_FOLDERS_RECENT_PATHS, async (input) => {
    decodeNone(input);
    return (await owners.folders.roots.listRecentRoots()).map((entry) => entry.path);
  });
  serve(HOST_INDEX_EMBEDDING_STOP, async (input) => {
    decodeNone(input);
    await owners.embeddingStop();
    return null;
  });
}
