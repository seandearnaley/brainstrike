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
## 2026-04-15 - `aria-pressed` requires a stable accessible name
**Learning:** Per the [WAI-ARIA APG toggle button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/), a button that uses `aria-pressed` MUST have a name that doesn't change with state — otherwise assistive tech announces both signals together (e.g. "Resume background indexing, toggle button, pressed") which is contradictory. If the visible label flips ("Pause" ↔ "Resume") the visible label IS the state indicator and `aria-pressed` is redundant; if `aria-pressed` is the state indicator, the accessible name needs to stay stable.
**Action:** When a button toggles a persistent state, pick one pattern: (a) keep the visible verb-text and skip `aria-pressed`, or (b) keep `aria-pressed` and pin a stable `aria-label` (e.g. `aria-label="Background indexing"`) so the screen-reader name doesn't flip. The Pause/Resume background-indexing control in `CollectionSyncStatusItem` uses (b).

## 2026-05-03 - Use `useId()` for form-control IDs in reusable components
**Learning:** Custom form controls inside reusable components (like the slider and tag input in `PromptEditor`) used static string IDs for `<Label htmlFor>` / `id` pairs. If the component is ever rendered more than once on the same page, the duplicate IDs break the htmlFor association — the label only targets the first element with that ID, defeating the accessibility purpose.
**Action:** When pairing a `Label` with a custom `<input>` inside a component that may be instantiated multiple times, derive the IDs from React's `useId()` hook rather than hardcoded strings. This guarantees uniqueness across instances without leaking implementation details.

## 2026-05-04 - Native Title Attributes cause Double Tooltips
**Learning:** Icon-only navigation buttons (e.g., in TablePagination) using native `title` attributes provide a poor, unstyled UX and can conflict with custom app tooltips.
**Action:** Always replace native `title` attributes on icon-only buttons with the design system's `Tooltip` component (wrapping the button) for consistent, accessible visual feedback. Remember to include `TooltipProvider` if one is not guaranteed at the app level.
