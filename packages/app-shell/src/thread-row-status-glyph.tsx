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
import type { ThreadRowStatusState } from './assistant-thread-presentation';

/**
 * Shared corner geometry. The dot states reuse the spinner's exact box so the
 * glyph never nudges the icon it overlays when the state changes.
 */
const GLYPH_CLASS_NAME =
  'pointer-events-none absolute -right-1 -bottom-1 size-3 rounded-full border border-background shadow-sm';

const DOT_PRESENTATION = {
  'done-unseen': {
    className: 'bg-primary',
    describe: (title: string) => `${title} has unseen activity`,
    testId: 'thread-unseen-glyph',
  },
  'failed-unseen': {
    className: 'bg-destructive',
    describe: (title: string) => `${title} failed`,
    testId: 'thread-failed-glyph',
  },
  'needs-you': {
    // A RAW, PER-THEME palette pair on purpose, unlike its `bg-primary` /
    // `bg-destructive` siblings — and NOT the `--bs-warning` token.
    //
    // `packages/ui/src/globals.css` defines `--bs-warning` but never maps it to
    // a `--warning` semantic var or a `--color-warning` @theme entry, so there
    // is no `bg-warning` utility. Wiring one the way `--bs-destructive` is
    // wired would not fix anything here: `--bs-warning` is `hsl(38 92% 50%)`,
    // which measures 1.89:1 against the light row surface — it is a SURFACE
    // token, paired with a dark `--bs-warning-foreground` to sit behind text,
    // not a mark that has to contrast with the page. Darkening it to clear the
    // floor would break that pairing for every future consumer.
    //
    // So the glyph carries the per-theme pair the rest of this codebase
    // already uses for amber (`text-amber-700 dark:text-amber-300` and
    // siblings). Measured against the surfaces CDT sampled — rgb(243,241,239)
    // light, rgb(41,39,37) dark — `amber-700` is 4.47:1 in light (was 1.91:1
    // with `amber-500`, below WCAG 1.4.11's 3:1 for non-text UI) and
    // `amber-500` stays at 6.97:1 in dark, i.e. exactly what it measured
    // before. A single class cannot serve both: `amber-600` is 2.84:1 in
    // light and `amber-700` is 2.96:1 in dark.
    className: 'bg-amber-700 dark:bg-amber-500',
    describe: (title: string) => `${title} needs your approval`,
    testId: 'thread-needs-you-glyph',
  },
} as const satisfies Record<
  Exclude<ThreadRowStatusState, 'running'>,
  {
    readonly className: string;
    readonly describe: (title: string) => string;
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
        aria-label={`${title} is active`}
        className={`${GLYPH_CLASS_NAME} animate-spin bg-background text-current motion-reduce:animate-none`}
        data-testid="thread-active-spinner"
        role="img"
      />
    );
  }
  const presentation = DOT_PRESENTATION[state];
  return (
    <span
      aria-label={presentation.describe(title)}
      className={`${GLYPH_CLASS_NAME} ${presentation.className}`}
      data-testid={presentation.testId}
      role="img"
    />
  );
}
