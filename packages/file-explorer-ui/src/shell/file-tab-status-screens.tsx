import { INACCESSIBLE_CONTENT_PREFIX, type TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { Button } from '@brainstrike/ui';
import { AlertCircle, FolderX, Loader2, LockKeyhole } from 'lucide-react';
import type { ReactElement } from 'react';
import type { FileFolderStatus } from './file-folder-status.ts';
import { type ClosedFolder, closedFolderWords, openingFolderLabel } from './folder-status-words.ts';

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

/** A named folder opening says so; otherwise a restore in flight says that, before a bare wait. */
function pendingLabel(isPending: boolean, openingFolderName: string | null | undefined): string {
  if (openingFolderName) {
    return openingFolderLabel(openingFolderName);
  }
  if (isPending) {
    return 'Restoring…';
  }
  return openingFolderName === null ? openingFolderLabel(null) : 'Loading…';
}

export function FileContentPendingScreen({
  isPending,
  openingFolder,
}: {
  readonly isPending: boolean;
  /** The file's folder is opening; `name` is null when it is not known. */
  readonly openingFolder?: { readonly name: string | null } | undefined;
}): ReactElement {
  const label = pendingLabel(isPending, openingFolder?.name);
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
 * The file's folder is not open, so its content cannot load. Reopen mounts it again (a folder in
 * Recents); a folder this window cannot reopen (a thread's worktree) comes back with its thread.
 */
export function FolderClosedScreen({
  onCloseTab,
  onReopen,
  path,
  status,
}: {
  readonly onCloseTab: () => void;
  readonly onReopen: (() => void) | undefined;
  readonly path: string;
  readonly status: ClosedFolder;
}): ReactElement {
  const words = closedFolderWords(status, onReopen !== undefined);
  return (
    <div
      aria-labelledby="file-folder-closed-title"
      className="flex h-full flex-col items-center justify-center p-4 text-center"
      data-testid="file-folder-closed"
      role="alert"
    >
      <FolderX aria-hidden="true" className="text-muted-foreground mb-4 h-12 w-12" />
      <p className="text-lg font-semibold" id="file-folder-closed-title">
        {words.title}
      </p>
      <p className="text-muted-foreground mt-2 max-w-md text-sm">{words.detail}</p>
      <p className="text-muted-foreground mt-1 max-w-md text-xs break-all">{path}</p>
      <div className="mt-4 flex gap-2">
        {onReopen ? (
          <Button onClick={onReopen} type="button">
            {words.reopen}
          </Button>
        ) : null}
        <Button onClick={onCloseTab} type="button" variant="outline">
          Close tab
        </Button>
      </div>
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

/**
 * The side pane's and breadcrumb's line for a file whose folder is not open: the same status and
 * words as the tab body, in a small space.
 */
export function FolderStatusNotice({
  onReopen,
  status,
  testId,
}: {
  readonly onReopen: (() => void) | undefined;
  readonly status: Exclude<FileFolderStatus, { kind: 'open' }>;
  readonly testId: string;
}): ReactElement {
  if (status.kind === 'opening') {
    return (
      <div
        className="text-muted-foreground flex h-full items-center justify-center p-4 text-xs"
        data-testid={testId}
        role="status"
      >
        <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
        {openingFolderLabel(status.name)}
      </div>
    );
  }
  const words = closedFolderWords(status, onReopen !== undefined);
  return (
    <div
      className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs"
      data-testid={testId}
    >
      <p className="text-foreground font-medium">{words.title}</p>
      {/* Beside the file's own text the Reopen button says enough; a reason always shows. */}
      {onReopen && status.failure === null ? null : <p>{words.detail}</p>}
      {onReopen ? (
        <Button onClick={onReopen} size="sm" type="button" variant="outline">
          {words.reopen}
        </Button>
      ) : null}
    </div>
  );
}
