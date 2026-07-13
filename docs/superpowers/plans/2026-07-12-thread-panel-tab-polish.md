# Thread Panel and Assistant Tabs UX Plan

**Date:** 2026-07-12  
**Branch:** `codex/thread-panel-tab-polish`  
**Base:** `origin/main` at `0d6044e8aa22a89634e97d3444e644b394b82043`

## Product outcome

Make thread navigation feel like a first-class local workspace rather than a stack of cards: titles retain priority at every panel width, folders read like compact explorer groups, bulk operations stay close to the selection, list and folder-tree ordering are independently controllable, thread/folder colors carry into open tabs, and the tab strip supports fast, predictable reordering without visual noise.

The aesthetic direction is restrained desktop utility: dense but calm, token-driven, symmetrical, and low-chrome. Motion communicates selection, insertion, and focus; it does not decorate idle UI. Existing Brainstrike components, Lucide icons, semantic colors, context actions, and Pragmatic Drag and Drop remain the visual and interaction vocabulary.

## Architecture decisions

1. **The resized panel owns responsive density.** Use a named container and component-level presentation modes so title space is protected before secondary controls. Do not use viewport breakpoints as a proxy for the panel width.
2. **Threads and folders are one navigable collection.** Flatten the visible grouped view into typed rows for windowing, selection, keyboard navigation, and drag targeting. Group headers remain semantic sections; thread rows become compact explorer-style rows inside them.
3. **Virtualization and disclosure solve different problems.** Use the repo-standard `@tanstack/react-virtual` for DOM/windowing cost, plus a visible-item limit with an explicit “Show more” affordance so very large histories are understandable rather than merely fast. Collapsed groups and the visible limit are applied before virtualization.
4. **Sorting state is scoped by presentation.** Persist independent flat-list and grouped-tree sort choices. Manual drag order switches only the affected presentation to custom order. No silent coercion between the two modes.
5. **Selection is ephemeral UI state.** Multi-selection stays local to the panel, is pruned when threads disappear or resources change, supports standard modifier/range behavior, and drives one floating bulk-action bar modeled on Tapestry. Destructive bulk deletion remains explicit and confirmable.
6. **Color has a single semantic source.** Thread metadata remains the source for thread color. Groups gain explicit color metadata through the existing repository/store boundary, and open thread tabs resolve their accent from the loaded thread metadata. Missing color is represented as unassigned, not guessed from position.
7. **Tab order is durable workspace state.** Reordering open tabs updates the existing assistant thread store atomically. Pragmatic Drag and Drop provides pointer drag semantics; keyboard-accessible move actions remain available through the context-action system.
8. **No new persistence bypasses reset.** Any persisted view preference or group metadata change is owned by the existing persisted store/repository and covered by its reset/migration tests.

## Acceptance criteria

### Threads panel

- At narrow widths, the title truncates last; details and per-row actions progressively collapse into compact/overflow presentation.
- Thread rows align with explorer-folder rhythm: compact height, stable indentation, matching disclosure/selection affordances, and symmetric gutters.
- Folder rows support color assignment with the same palette as threads, without relying on color alone for identity.
- Multi-select supports individual, range, group, and visible-item selection; the floating action bar supports move, color, and delete flows with clear counts and escape/clear behavior.
- Flat and grouped views remember independent sort modes.
- Large collections render through a virtualized visible-row model and expose an explicit Show more control with an accurate remaining count.
- Dragging threads between/reordering groups still works in custom order and exposes insertion feedback without layout jump.
- Loading, empty, error, rename, delete-confirmation, keyboard focus, and reduced-motion states remain explicit.

### Assistant tab strip

- A colored thread produces the same accent identity on its open tab; unassigned threads remain neutral.
- Tabs resize fluidly within bounded min/max widths, preserving active-title readability before close/secondary chrome.
- Pointer drag reorders tabs with an insertion indicator and auto-scroll near strip edges.
- Keyboard/context actions can move a tab left/right and close variants without requiring drag.
- Active, hover, focus, pressed, drag, and overflow states are visually distinct in light and dark themes.
- Motion uses transform/opacity, is interruptible, and respects `prefers-reduced-motion`.

## Red/green implementation slices

1. **Sorting contract** — add failing pure/store tests for independent flat/grouped sort state and migration; implement the scoped preferences.
2. **Visible row model** — add failing tests for flattening groups, disclosure limits, counts, and selection pruning; implement typed rows and show-more state.
3. **Responsive compact rows** — add failing component tests for title priority, compact actions, group selection, and bulk-bar semantics; implement the panel-owned container presentation.
4. **Windowed rendering** — add a deterministic virtualizer test harness and prove bounded mounted rows with large fixtures; integrate `@tanstack/react-virtual` without breaking dynamic rename/detail rows.
5. **Group color** — add repository/store/component tests first; update the paired DB migration/catalog paths only if the current group metadata schema cannot hold color. Prefer existing metadata capacity when present.
6. **Bulk actions** — add behavior tests for range/group selection, move/color operations, confirmation, and selection cleanup; implement one floating action surface.
7. **Tab color and refinement** — add failing tab tests for accent resolution, title priority, focus semantics, and overflow behavior; implement the polished strip.
8. **Tab reorder** — add store and DnD resolver tests, then component tests for pointer/keyboard reorder and focus retention; implement atomic order updates and insertion feedback.
9. **Visual and runtime proof** — add focused web/Electron coverage for narrow/wide panels, large thread sets, light/dark themes, reduced motion, keyboard operation, and drag/reorder. Inspect geometry, console, and runtime state through the agent-debug surface.

## Parallel workflow

- **Thread A — interaction/state contract:** sorting separation, visible-row model, selection semantics, bulk action state, and tests.
- **Thread B — tab controller:** tab color propagation, responsive strip, store reorder contract, DnD, motion, and tests.
- **Thread C — visual/runtime QA:** baseline capture, Tapestry/explorer pattern inventory, focused E2E scenarios, accessibility/geometry checklist, and later independent review.
- **Primary integration thread:** repository/schema decisions, responsive thread-row implementation, cross-thread integration, root gates, commits, PR publication, exact-head CI and review closure.

Each thread owns disjoint files until integration. Shared store or test-support edits are coordinated through the primary thread. Every slice begins with a failing behavior test and lands as a focused commit.

## Verification gate

Focused tests run after each slice. Before publication, one uninterrupted root run must pass:

```text
pnpm secrets:scan
pnpm test:scripts
pnpm dlx ultracite fix
pnpm dlx ultracite check
pnpm lint
pnpm type-check
pnpm build
pnpm test
pnpm doctor
```

Then run the relevant web and desktop smoke lanes plus agent-debug visual checks. Publish the exact tested SHA, open the PR, and monitor that exact head until required checks are green and every review thread has either a fix plus reply or a reasoned visible reply. Do not merge without separate authorization.
