import { Folder } from 'lucide-react';
import type { ReactElement } from 'react';

/**
 * A delegated child's workspace: the folder it shares with its root thread.
 * The root owns the folder, so the chip only names it, with no menu to add or
 * change one. The folder chip's shape, without its trigger.
 */
export const SharedFolderChip = ({
  displayName,
  path,
}: {
  /** The root's folder; absent while the root has none and tools pick an open one. */
  readonly displayName: string | undefined;
  readonly path?: string | undefined;
}): ReactElement => (
  <span
    className="bs-composer-chip"
    data-testid="workspace-bar-shared-folder"
    {...(path ? { title: path } : {})}
  >
    <Folder aria-hidden="true" />
    <span className="sr-only">Shared workspace: </span>
    <span className="bs-composer-chip-label">{displayName ?? 'tools select an open folder'}</span>
  </span>
);
