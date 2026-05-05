## 2025-03-03 - Inconsistent ARIA roles on structural toggle buttons

**Learning:** Some structural UI elements (like `FolderHeaderRow`) responsible for expanding/collapsing lists omit `aria-expanded` and `aria-label` attributes, while others in the UI package (like `TableGroupHeader`) correctly include them.
**Action:** Always ensure any button that controls the expansion or collapsing of a section or list includes `aria-expanded` indicating the current state, and an `aria-label` describing the action and target.

## 2025-03-13 - Missing ARIA Labels on Tooltip Icon Buttons

**Learning:** Icon buttons wrapped in Tooltips (like `TooltipIconButton`) provide hover text but lack accessible names for screen readers, as the tooltip content isn't automatically associated as a label.
**Action:** Always map the `tooltip` prop to the `aria-label` of the underlying button when building Tooltip-wrapped icon components to ensure consistent accessibility for all users.

## 2026-03-16 - Critical Loss of ARIA Roles in Simplified Components
**Learning:** Simplifying components by removing robust UI primitives (like Radix UI `Progress`) often unintentionally strips essential ARIA roles, specifically `role="progressbar"`, `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`. This completely breaks the component's semantic meaning for screen readers.
**Action:** When migrating away from external UI primitives or building components from scratch, always verify that the semantic ARIA roles and state attributes are explicitly re-implemented to maintain accessibility.

## 2026-03-27 - [Added Accessible Labels to PromptCard Favorite Button]
**Learning:** Icon-only buttons representing binary toggle actions (like adding/removing a favorite) often omit `aria-label` and `title` attributes, making them inaccessible to screen readers and lacking native tooltips for mouse users.
**Action:** Always provide descriptive and dynamic `aria-label` and `title` attributes (e.g., 'Add to favorites' / 'Remove from favorites') for icon-only toggle buttons, especially those using `size="icon"` from the UI package.
## 2026-03-31 - Missing ARIA labels and wrong size prop on icon-only action buttons

**Learning:** Icon-only action buttons in lists (like Edit/Delete in `CollectionPickerItem`) sometimes lack `aria-label` attributes and use `size="sm"` with custom width/height/padding classes instead of the standard `size="icon"` which is designed specifically for square icon buttons.
**Action:** Always provide descriptive `aria-label` attributes for icon-only action buttons and prefer `size="icon"` over manually overriding `size="sm"` padding/dimensions when rendering purely icon-based buttons.

## 2026-04-15 - `aria-pressed` on persistent toggle buttons
**Learning:** Buttons that toggle a persistent on/off state (like the background-indexing Pause/Resume control in `CollectionSyncStatusItem`) need `aria-pressed` set to the current state so screen readers announce the toggle state explicitly, not just the button label.
**Action:** When a single button toggles a persistent state and the rendered label changes ("Pause" ↔ "Resume"), set `aria-pressed={isOn}` so the toggle role is exposed correctly. The label-flip alone isn't sufficient — assistive tech expects the explicit `aria-pressed` semantic.
