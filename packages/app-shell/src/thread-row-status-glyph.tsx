/**
 * The one badge slot a Threads-panel row spends on run state (BST-1405).
 *
 * Four facts compete for the same 12px corner of the thread's identity mark,
 * and they are NOT independent decorations: a thread parked on an approval is
 * also "running" by the active-run projection, and a failed run is also
 * "unseen". Rendering them side by side would put three dots on one row and
 * bury the only one that asks the user for something. So this module owns the
 * priority once, as a pure function — `resolveThreadRowStatusState` in
 * `assistant-thread-presentation.ts`, beside the panel's other shared
 * presentation rules — and the row renders whatever it returns:
 *
 *   needs-you > running > failed-unseen > done-unseen
 *
 * Each input comes from a DIFFERENT list-wide projection (one live query per
 * signal, never per row) — see `use-threads-awaiting-approval.ts`,
 * `use-active-assistant-thread-ids.ts` and `use-unseen-thread-ids.ts`. A
 * projection that FAILED reports an empty set plus an error, and the panel
 * renders that error explicitly rather than letting this glyph quietly claim
 * "nothing to see".
 */
import { LoaderCircle } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  getThreadRowAccessibleName,
  type ThreadRowStatusState,
} from './assistant-thread-presentation';

/**
 * Shared corner geometry. The dot states reuse the spinner's exact box so the
 * glyph never nudges the icon it overlays when the state changes.
 */
const GLYPH_CLASS_NAME =
  'pointer-events-none absolute -right-1 -bottom-1 size-3 rounded-full border border-background shadow-sm';

const DOT_PRESENTATION = {
  'done-unseen': {
    className: 'bg-primary',
    testId: 'thread-unseen-glyph',
  },
  'failed-unseen': {
    className: 'bg-destructive',
    testId: 'thread-failed-glyph',
  },
  'needs-you': {
    // The shared semantic token is contrast-graded against both row surfaces
    // in `warning-theme-contract.test.mjs`; consumers never choose raw amber.
    className: 'bg-warning',
    testId: 'thread-needs-you-glyph',
  },
} as const satisfies Record<
  Exclude<ThreadRowStatusState, 'running'>,
  {
    readonly className: string;
    readonly testId: string;
  }
>;

export function ThreadRowStatusGlyph({
  state,
  title,
}: {
  readonly state: ThreadRowStatusState | null;
  /** The thread title, so every glyph names the row it belongs to. */
  readonly title: string;
}): ReactElement | null {
  if (state === null) {
    return null;
  }
  if (state === 'running') {
    return (
      <LoaderCircle
        aria-label={getThreadRowAccessibleName(state, title)}
        className={`${GLYPH_CLASS_NAME} animate-spin bg-background text-current motion-reduce:animate-none`}
        data-testid="thread-active-spinner"
        role="img"
      />
    );
  }
  const presentation = DOT_PRESENTATION[state];
  return (
    <span
      aria-label={getThreadRowAccessibleName(state, title)}
      className={`${GLYPH_CLASS_NAME} ${presentation.className}`}
      data-testid={presentation.testId}
      role="img"
    />
  );
}
