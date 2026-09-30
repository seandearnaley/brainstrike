import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { Button } from '@brainstrike/ui';
import { AlertCircle, Loader2, LockKeyhole } from 'lucide-react';
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
      <LockKeyhole aria-hidden="true" className="mb-4 h-12 w-12 text-warning" />
      <p className="font-semibold text-lg">File Access Required</p>
      <p className="mt-2 max-w-md text-muted-foreground text-sm">
        Click the tab again to restore access to this file. Your browser requires permission to read
        files after a page reload.
      </p>
      {status.error ? <p className="mt-2 text-destructive text-xs">{status.error}</p> : null}
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
      <AlertCircle aria-hidden="true" className="mb-4 h-12 w-12 text-destructive" />
      <p className="font-semibold text-lg">File Not Found</p>
      <p className="mt-2 max-w-md text-muted-foreground text-sm">
        This file could not be restored. It may have been moved, renamed, or deleted.
      </p>
      <p className="mt-1 text-muted-foreground text-xs">{path}</p>
      {status.error ? <p className="mt-2 text-destructive text-xs">{status.error}</p> : null}
    </div>
  );
}

export function FileContentPendingScreen({
  isPending,
}: {
  readonly isPending: boolean;
}): ReactElement {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
      <span>{isPending ? 'Restoring…' : 'Loading…'}</span>
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
      <AlertCircle aria-hidden="true" className="mb-4 h-12 w-12 text-destructive" />
      <p className="font-semibold text-lg" id="file-content-error-title">
        File content unavailable
      </p>
      <p className="mt-2 max-w-md text-muted-foreground text-sm">
        Brainstrike could not load this file. Retry the read when you are ready.
      </p>
      <p className="mt-2 text-destructive text-sm">{describeFileContentError(contentError)}</p>
      <p className="mt-1 max-w-md break-all text-muted-foreground text-xs">{path}</p>
      <Button className="mt-4" onClick={onRetry} type="button" variant="outline">
        Retry file content
      </Button>
    </div>
  );
}

export function InaccessibleFileScreen({ content }: { readonly content: string }): ReactElement {
  return (
    <div className="h-full overflow-auto p-4">
      <p className="text-warning">{content}</p>
      <p className="mt-2 text-muted-foreground text-sm">
        To access this file, please open the folder again using the folder icon button. This is a
        security measure of your browser.
      </p>
    </div>
  );
}
