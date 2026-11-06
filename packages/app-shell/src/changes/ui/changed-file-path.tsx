/**
 * A changed file's path, named by its file name first. The directory follows
 * in a muted tone and is what gives way when the row is narrow, so files in
 * one long directory stay told apart instead of all truncating to the same
 * prefix. A rename reads `old → new`. The whole path is the hover title.
 */
import type { ChangedFileEntry } from '@brainstrike/types';
import { PathLabel, splitPathLabel } from '@brainstrike/ui';
import type { ReactElement } from 'react';

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
  const { directory, name } = splitPathLabel(entry.path);
  return (
    <PathLabel
      className={className}
      directory={directory}
      name={name}
      prefix={entry.oldPath ? `${entry.oldPath} → ` : undefined}
      title={changedFileDisplayPath(entry)}
    />
  );
}
