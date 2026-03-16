## 2025-03-03 - Inconsistent ARIA roles on structural toggle buttons

**Learning:** Some structural UI elements (like `FolderHeaderRow`) responsible for expanding/collapsing lists omit `aria-expanded` and `aria-label` attributes, while others in the UI package (like `TableGroupHeader`) correctly include them.
**Action:** Always ensure any button that controls the expansion or collapsing of a section or list includes `aria-expanded` indicating the current state, and an `aria-label` describing the action and target.

## 2025-03-13 - Missing ARIA Labels on Tooltip Icon Buttons

**Learning:** Icon buttons wrapped in Tooltips (like `TooltipIconButton`) provide hover text but lack accessible names for screen readers, as the tooltip content isn't automatically associated as a label.
**Action:** Always map the `tooltip` prop to the `aria-label` of the underlying button when building Tooltip-wrapped icon components to ensure consistent accessibility for all users.

## 2026-03-16 - Critical Loss of ARIA Roles in Simplified Components
**Learning:** Simplifying components by removing robust UI primitives (like Radix UI `Progress`) often unintentionally strips essential ARIA roles, specifically `role="progressbar"`, `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`. This completely breaks the component's semantic meaning for screen readers.
**Action:** When migrating away from external UI primitives or building components from scratch, always verify that the semantic ARIA roles and state attributes are explicitly re-implemented to maintain accessibility.
