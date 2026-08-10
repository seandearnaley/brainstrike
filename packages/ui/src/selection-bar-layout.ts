/**
 * Bottom breathing room a scrollport needs while the floating selection bar is
 * up, so the last row or card stays reachable underneath it.
 *
 * Applied to the SCROLL OWNER, never to the content it scrolls — padding on the
 * content moves with the scroll and stops clearing the bar once you reach the
 * end. One spelling for one invariant: the Explorer tree and the context
 * preview's Tapestry gallery both float the same `SelectionActionBarOverlay`,
 * and a second hardcoded `pb-20` is how they drift apart.
 */
export const SELECTION_BAR_SCROLL_PADDING = 'pb-20';
