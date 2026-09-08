import { useState } from 'react';

/**
 * The status label's entrance class (phase-2 follow-up). The label element is
 * keyed on its own text, so it re-mounts — replaying `bs-trace-label-enter` —
 * whenever the wording changes; that is what the animation is for. The
 * group's FIRST paint is not a change of wording, though: the whole trace
 * appears at once, and animating the label there made the row arrive twice
 * over. So until the wording has changed at least once, the label is static.
 *
 * Derived state (React's documented "adjust state while rendering" pattern),
 * NOT a mount flag read fresh on each render: the trace re-renders
 * constantly for reasons unrelated to the wording — the elapsed clock ticks
 * every 100ms while a group is live, and opening the group is a state change
 * of its own — and a per-render read swaps the entrance class onto the
 * untouched first label at the first of those, animating exactly the entrance
 * this rule suppresses (pinned by "a re-render that leaves the wording alone
 * never re-triggers the entrance" in activity-trace.browser.test.tsx). It is
 * also why the flag stays on afterwards rather than tracking the latest
 * change: toggling it back off would strip the animation off a label
 * mid-flight.
 *
 * Lives in its own `use-*.ts` module (BST-1684) so `activity-trace.tsx` exports
 * components only — the Fast Refresh boundary rule.
 */
export function useLabelEnterClass(label: string): string {
  const [renderedLabel, setRenderedLabel] = useState(label);
  const [hasChanged, setHasChanged] = useState(false);
  if (renderedLabel !== label) {
    setRenderedLabel(label);
    setHasChanged(true);
  }
  return hasChanged ? 'bs-trace-label' : 'bs-trace-label-static';
}
