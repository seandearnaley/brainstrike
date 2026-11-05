/**
 * A proposed edit, before it exists in git (ADR-0036): the agent's old and new
 * text for one replacement. Nothing on disk holds it yet, so @pierre/diffs
 * diffs the two strings. They are a fragment, not the file, so the view shows
 * no line numbers and leaves naming the file to its caller.
 */
import type { FileDiffOptions } from '@pierre/diffs/react';
import { MultiFileDiff } from '@pierre/diffs/react';
import type { ReactElement } from 'react';
import { useDiffAppearance } from './diff-appearance';

export interface FileDiffViewProps {
  readonly ariaLabel: string;
  readonly newText: string;
  readonly oldText: string;
  /** Names the language for highlighting. */
  readonly path: string;
  readonly testId?: string | undefined;
}

export function FileDiffView({
  ariaLabel,
  newText,
  oldText,
  path,
  testId,
}: FileDiffViewProps): ReactElement {
  const options: FileDiffOptions<undefined, undefined> = {
    ...useDiffAppearance(),
    diffStyle: 'unified',
    disableFileHeader: true,
    disableLineNumbers: true,
  };
  return (
    <section aria-label={ariaLabel} className="h-full overflow-auto" data-testid={testId}>
      <MultiFileDiff
        newFile={{ contents: newText, name: path }}
        oldFile={{ contents: oldText, name: path }}
        options={options}
      />
    </section>
  );
}
