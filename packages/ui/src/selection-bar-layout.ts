/**
 * Bottom breathing room a scrollport needs while the floating selection bar is
 * up, so the last row or card stays reachable underneath it.
 *
 * Applied to the SCROLL OWNER, never to the content it scrolls — padding on the
 * content moves with the scroll and stops clearing the bar once you reach the
 * end. One spelling for one invariant: every surface that floats the
 * `SelectionActionBarOverlay` uses it, so a second hardcoded `pb-20` can't
 * drift apart from it.
 */
export const SELECTION_BAR_SCROLL_PADDING = 'pb-20';
