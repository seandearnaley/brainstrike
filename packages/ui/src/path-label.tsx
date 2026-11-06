import type { ReactElement } from 'react';
import { cn } from './lib/utils';

export interface PathLabelProps {
  readonly className?: string | undefined;
  /** The containing folder, muted; '' when there is none. */
  readonly directory: string;
  /** Extra classes for the folder, such as a smaller size than the name. */
  readonly directoryClassName?: string | undefined;
  /** The file's own name, which stays readable first. */
  readonly name: string;
  /** Muted text before the name, such as a rename's `old → `. */
  readonly prefix?: string | undefined;
  /** The hover title; defaults to the folder and name joined. */
  readonly title?: string | undefined;
}

/** Split a `/`-separated path at its last slash into its folder and name. */
export function splitPathLabel(path: string): {
  readonly directory: string;
  readonly name: string;
} {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { directory: '', name: path }
    : { directory: path.slice(0, slash), name: path.slice(slash + 1) };
}

/**
 * A path named by its file name first. The folder follows in a muted tone and
 * is what gives way when the row is narrow, losing its START so the nearest
 * folders stay visible. The whole path is the hover title.
 */
export function PathLabel({
  className,
  directory,
  directoryClassName,
  name,
  prefix,
  title,
}: PathLabelProps): ReactElement {
  return (
    <span
      className={cn('flex min-w-0 items-baseline gap-1.5', className)}
      title={title ?? (directory ? `${directory}/${name}` : name)}
    >
      <span className="max-w-full shrink-0 truncate">
        {prefix ? <span className="text-muted-foreground">{prefix}</span> : null}
        {name}
      </span>
      {directory ? (
        <span
          className={cn(
            'text-muted-foreground min-w-0 truncate [direction:rtl]',
            directoryClassName
          )}
        >
          {/* The bdi keeps the path's own left-to-right order inside the rtl box,
              which only exists to put the ellipsis at the folder's start. */}
          <bdi>{directory}</bdi>
        </span>
      ) : null}
    </span>
  );
}
