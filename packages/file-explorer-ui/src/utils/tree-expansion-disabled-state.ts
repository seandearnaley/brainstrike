/**
 * ONE disabled rule for Expand All / Collapse All (whole-branch review F11).
 *
 * The actions render as toolbar buttons at 236px and up and as compact-menu
 * items below it. A menu item that stays clickable while its button
 * counterpart is disabled is a silent divergence, so both surfaces derive
 * availability here rather than each re-deciding it.
 */
export interface TreeExpansionDisabledState {
  collapse: boolean;
  expand: boolean;
}

export function resolveTreeExpansionDisabledState(props: {
  isExpandingAll: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
}): TreeExpansionDisabledState {
  return {
    // Collapse stays enabled while expanding — it doubles as the stop
    // affordance (the panel's collapseAll cancels the running sweep first).
    collapse: props.isLoading || props.isRefreshing,
    expand: props.isLoading || props.isRefreshing || props.isExpandingAll,
  };
}
