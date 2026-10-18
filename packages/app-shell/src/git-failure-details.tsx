import type { ReactElement } from 'react';
import { summarizeGitFailure } from './git-failure-summary';

/** Longest git output the disclosure renders; a longer tail is left to the log. */
const MAX_DETAILS_LENGTH = 20_000;

function boundedDetails(full: string): string {
  if (full.length <= MAX_DETAILS_LENGTH) {
    return full;
  }
  const omitted = full.length - MAX_DETAILS_LENGTH;
  return `${full.slice(0, MAX_DETAILS_LENGTH)}\n… ${omitted.toLocaleString()} more characters; the full output is in the log.`;
}

/**
 * A git failure in an error state (BST-2136): the one-line summary, and the
 * full output behind a native, keyboard-operable disclosure when there is more
 * to it. Raw stderr is never the headline, but the detail a Git user needs (a
 * rejected push, a conflict list) stays one click away.
 */
export function GitFailureDetails({
  className = 'max-w-md',
  error,
  summaryClassName = 'text-muted-foreground text-xs',
}: {
  /** Width/alignment of the block within its error state. */
  readonly className?: string;
  readonly error: string;
  readonly summaryClassName?: string;
}): ReactElement {
  const summary = summarizeGitFailure(error);
  const full = error.trim();
  return (
    <div className={`flex w-full flex-col gap-1 ${className}`}>
      <p className={summaryClassName}>{summary}</p>
      {full === summary ? null : (
        <details className="w-full text-left text-xs" data-testid="git-failure-details">
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            Full git output
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px] text-foreground">
            {boundedDetails(full)}
          </pre>
        </details>
      )}
    </div>
  );
}
