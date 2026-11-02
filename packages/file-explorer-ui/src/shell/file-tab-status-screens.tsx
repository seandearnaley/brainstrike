import { INACCESSIBLE_CONTENT_PREFIX, type TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { Button } from '@brainstrike/ui';
import { AlertCircle, FolderX, Loader2, LockKeyhole } from 'lucide-react';
import type { ReactElement } from 'react';

/**
 * Full-body status screens for a file tab (BST-1258 file split): rendered by
 * `FileTabBody` in place of a content surface when the tab cannot show file
 * text yet (or ever). Kept together because they share the centered-column
 * layout and the aria-live announcement pattern.
 */

export function PermissionRequiredScreen({
  path,
  status,
}: {
  readonly path: string;
  readonly status: TabFileStatus;
}): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div aria-live="polite" className="sr-only">
        File access required for {path}. Click the tab to restore access.
      </div>
      <LockKeyhole aria-hidden="true" className="text-warning mb-4 h-12 w-12" />
      <p className="text-lg font-semibold">File Access Required</p>
      <p className="text-muted-foreground mt-2 max-w-md text-sm">
        Click the tab again to restore access to this file. Your browser requires permission to read
        files after a page reload.
      </p>
      {status.error ? <p className="text-destructive mt-2 text-xs">{status.error}</p> : null}
    </div>
  );
}

export function FileNotFoundScreen({
  path,
  status,
}: {
  readonly path: string;
  readonly status: TabFileStatus;
}): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div aria-live="polite" className="sr-only">
        File not found: {path}. This file may have been moved, renamed, or deleted.
      </div>
      <AlertCircle aria-hidden="true" className="text-destructive mb-4 h-12 w-12" />
      <p className="text-lg font-semibold">File Not Found</p>
      <p className="text-muted-foreground mt-2 max-w-md text-sm">
        This file could not be restored. It may have been moved, renamed, or deleted.
      </p>
      <p className="text-muted-foreground mt-1 text-xs">{path}</p>
      {status.error ? <p className="text-destructive mt-2 text-xs">{status.error}</p> : null}
    </div>
  );
}

export function FileContentPendingScreen({
  isPending,
  rootConnecting = false,
}: {
  readonly isPending: boolean;
  /** The file's folder is still being opened. */
  readonly rootConnecting?: boolean;
}): ReactElement {
  const label = rootConnecting ? 'Connecting folder…' : isPending ? 'Restoring…' : 'Loading…';
  return (
    <div
      aria-live="polite"
      className="text-muted-foreground flex h-full items-center justify-center"
      role="status"
    >
      <Loader2 aria-hidden="true" className="mr-2 h-5 w-5 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

/**
 * The file's folder is not open, so its content cannot load. Opening the thread that works in
 * the folder reconnects it; otherwise the folder is added again from the folder chip or Recents.
 */
export function FolderNotConnectedScreen({ path }: { readonly path: string }): ReactElement {
  return (
    <div
      aria-labelledby="file-folder-not-connected-title"
      className="flex h-full flex-col items-center justify-center p-4 text-center"
      role="alert"
    >
      <FolderX aria-hidden="true" className="text-muted-foreground mb-4 h-12 w-12" />
      <p className="text-lg font-semibold" id="file-folder-not-connected-title">
        Folder not connected
      </p>
      <p className="text-muted-foreground mt-2 max-w-md text-sm">
        This file's folder is no longer open. Open a thread that works in it, or add the folder
        again from Recents.
      </p>
      <p className="text-muted-foreground mt-1 max-w-md text-xs break-all">{path}</p>
    </div>
  );
}

function describeFileContentError(error: Error): string {
  if (error.message === 'File content worker is unavailable.') {
    return 'The file reader is unavailable.';
  }
  if (error.name === 'AbortError') {
    return 'The file read was cancelled.';
  }
  if (error.name === 'AggregateError') {
    return 'One or more file reads failed.';
  }
  return 'The file read failed.';
}

export function FileContentErrorScreen({
  contentError,
  onRetry,
  path,
}: {
  readonly contentError: Error;
  readonly onRetry: () => void;
  readonly path: string;
}): ReactElement {
  return (
    <div
      aria-labelledby="file-content-error-title"
      className="flex h-full flex-col items-center justify-center text-center"
      role="alert"
    >
      <AlertCircle aria-hidden="true" className="text-destructive mb-4 h-12 w-12" />
      <p className="text-lg font-semibold" id="file-content-error-title">
        File content unavailable
      </p>
      <p className="text-muted-foreground mt-2 max-w-md text-sm">
        Brainstrike could not load this file. Retry the read when you are ready.
      </p>
      <p className="text-destructive mt-2 text-sm">{describeFileContentError(contentError)}</p>
      <p className="text-muted-foreground mt-1 max-w-md text-xs break-all">{path}</p>
      <Button className="mt-4" onClick={onRetry} type="button" variant="outline">
        Retry file content
      </Button>
    </div>
  );
}

/** A read the host answered with a reason (not found, refused, unreadable): shown with Retry. */
export function InaccessibleFileScreen({
  content,
  onRetry,
  path,
}: {
  readonly content: string;
  readonly onRetry: () => void;
  readonly path: string;
}): ReactElement {
  const reason = content.startsWith(INACCESSIBLE_CONTENT_PREFIX)
    ? content.slice(INACCESSIBLE_CONTENT_PREFIX.length).replace(/^\s*-\s*/u, '')
    : content;
  return (
    <div
      aria-labelledby="file-inaccessible-title"
      className="flex h-full flex-col items-center justify-center p-4 text-center"
      role="alert"
    >
      <AlertCircle aria-hidden="true" className="text-destructive mb-4 h-12 w-12" />
      <p className="text-lg font-semibold" id="file-inaccessible-title">
        Can't open this file
      </p>
      <p className="text-muted-foreground mt-2 max-w-md text-sm">{reason || 'The read failed.'}</p>
      <p className="text-muted-foreground mt-1 max-w-md text-xs break-all">{path}</p>
      <Button className="mt-4" onClick={onRetry} type="button" variant="outline">
        Retry
      </Button>
    </div>
  );
}
