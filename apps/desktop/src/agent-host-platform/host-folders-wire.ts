import { WorkspaceDirectoryHandleSchema } from '@brainstrike/agent-host/protocol';
import { Schema } from 'effect';

/**
 * ADR-0029 stage 4: what Main asks of the agent host's folders, and what the host tells Main
 * about them. Main keeps the dialogs, the File menu and the OS recent documents.
 */
/** A folder the user picked in Main's dialog: the pick is the grant. */
export const HOST_FOLDERS_ADD_PICKED = 'host/folders/add-picked';
export const HostFoldersAddPickedSchema = Schema.Struct({ handle: WorkspaceDirectoryHandleSchema });
/** The recent folders, newest first, for the File menu. */
export const HOST_FOLDERS_RECENT_PATHS = 'host/folders/recent-paths';
export const HostFoldersRecentPathsResultSchema = Schema.Array(Schema.String);
/** A folder was granted: Main lists it in the OS recent documents and the File menu. */
export const PLATFORM_FOLDER_GRANTED = 'platform/folders/granted';
/** The host mounted a folder for the user (a worktree it created): Main's window shows it. */
export const PLATFORM_FOLDER_OPENED = 'platform/folders/opened';
export const PlatformFolderPathSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinCodePoints(1)),
});
