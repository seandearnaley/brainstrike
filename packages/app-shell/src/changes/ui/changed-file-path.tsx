/**
 * A changed file's path, named by its file name first. The directory follows
 * in a muted tone and is what gives way when the row is narrow, so files in
 * one long directory stay told apart instead of all truncating to the same
 * prefix. A rename reads `old → new`. The whole path is the hover title.
 */
import type { ChangedFileEntry } from '@brainstrike/types';
import { cn } from '@brainstrike/ui';
import type { ReactElement } from 'react';

function splitPath(path: string): { readonly directory: string; readonly name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { directory: '', name: path }
    : { directory: path.slice(0, slash), name: path.slice(slash + 1) };
}

function changedFileDisplayPath(entry: ChangedFileEntry): string {
  return entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
}

export function ChangedFilePath({
  className,
  entry,
}: {
  readonly className?: string;
  readonly entry: ChangedFileEntry;
}): ReactElement {
  const { directory, name } = splitPath(entry.path);
  const renamedFrom = entry.oldPath ? `${entry.oldPath} → ` : '';
  return (
    <span
      className={cn('flex min-w-0 items-baseline gap-1.5', className)}
      title={changedFileDisplayPath(entry)}
    >
      <span className="max-w-full shrink-0 truncate">
        {renamedFrom ? <span className="text-muted-foreground">{renamedFrom}</span> : null}
        {name}
      </span>
      {directory ? (
        <span className="text-muted-foreground min-w-0 truncate [direction:rtl]">
          {/* The bdi keeps the path's own left-to-right order inside the rtl box,
              which only exists to put the ellipsis at the directory's start. */}
          <bdi>{directory}</bdi>
        </span>
      ) : null}
    </span>
  );
}
