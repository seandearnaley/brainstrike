# Tab strip / tab controller research: primary sources (checked 2026-09-27)

**Versions checked on the npm registry, 2026-09-27:** react 19.3.0 · radix-ui 1.6.7 / @radix-ui/react-tabs 1.1.21 (2026-07-31) · @base-ui/react 1.8.0 (2026-09-04) · react-aria-components 1.21.1 · shadcn 4.21.0 · tailwindcss 4.3.3 · @atlaskit/pragmatic-drag-and-drop 4.0.0 (2026-09-24), -hitbox 3.0.0, -auto-scroll 3.2.1, -react-accessibility 3.2.4 · @dnd-kit/react 0.5.0 (2026-06-11; betas up to 2026-09-12), legacy @dnd-kit/core 6.3.1 (2024-12). Electron 44.4.5 ships Chromium 152.0.7977.130 (https://releases.electronjs.org/release/v44.4.5). The repo catalog pins react ^19.3.0, @radix-ui/react-tabs ^1.1.21, electron ^44.2.0 and tailwindcss ^4.3.3.

"Inference" marks my own conclusions drawn from the cited facts. Everything else is stated by the source.

---

## 1. WAI-ARIA APG Tabs

Source: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/ (no date on the page; the example pages say "last updated 12 August 2025").

- **Keys.** Tab moves focus into the list, landing on the active tab, then on to the panel. Left/Right move focus and wrap at the ends. Home/End are optional. Space/Enter activate the tab if focus didn't already activate it. Shift+F10 opens the tab's popup menu if it has one.
- **Delete (optional).** Closes the tab and its panel. Focus moves to the next tab, or to the previous tab if the closed one was last, and that tab can optionally be activated. The page says delete may instead, or also, be offered in a context menu.
- **Automatic vs manual activation.** APG recommends automatic activation "as long as their associated tab panels are displayed without noticeable latency". In practice that needs preloaded panels. Use manual activation (Space/Enter) when showing a panel is slow.
- **ARIA attributes.**
  - Tabs take `aria-selected` and `aria-controls`.
  - A tab with a popup menu takes `aria-haspopup="menu"` or `"true"`.
  - A vertical tablist takes `aria-orientation="vertical"`; the default is horizontal.
  - A tabpanel gets `tabindex="0"` when its first content isn't focusable.
- **Close button inside `role=tab`.** APG says nothing. Three sources settle it:
  - ARIA gives `tab` **Children Presentational: True**, in both 1.2 (https://www.w3.org/TR/wai-aria-1.2/#tab) and the current editor's draft dated 22 Sep 2026 (https://w3c.github.io/aria/#tab). A button nested in a tab is not exposed to assistive technology.
  - The HTML `<button>` content model forbids any interactive descendant and any descendant with `tabindex` (https://html.spec.whatwg.org/multipage/form-elements.html#the-button-element). Radix and Base UI triggers are native `<button>`s, so a close button can't be nested inside one.
  - A close button placed as a sibling inside `role=tablist` fails axe-core's `aria-required-children` check. The check treats any owned, screen-reader-visible element that has a role or is focusable as "unallowed", and skips nodes hidden from screen readers (https://github.com/dequelabs/axe-core/blob/develop/lib/checks/aria/aria-required-children-evaluate.js). axe's `aria-hidden-focus` rule passes for elements that are focusable but not tabbable, e.g. `tabindex=-1` (https://github.com/dequelabs/axe-core/blob/develop/lib/rules/aria-hidden-focus.json).
  - *Inference:* make the close button a mouse-only sibling (`aria-hidden="true" tabindex="-1"`). Give keyboard and screen-reader users Delete plus a context menu, as APG describes.
- **Overflow / scrollable tablist.** APG says nothing. The example uses percentage widths so the layout reflows under magnification.
  - WCAG 2.4.11 (AA) says a focused component must not be *entirely hidden* by author content. That applies to fade masks and sticky scroll buttons; the guidance suggests `scroll-padding` (https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html).
  - Fluent 2 moves extra tabs into an overflow menu (https://fluent2.microsoft.design/components/web/react/core/tablist/usage).
  - Primer collapses items into a "More" menu, hiding icons first (https://primer.style/product/components/underline-nav/).
- **Reordering.** The Tabs pattern doesn't cover it. The closest APG precedent is the rearrangeable listbox (https://www.w3.org/WAI/ARIA/apg/patterns/listbox/examples/listbox-rearrangeable/):
  - Alt+Up/Down move the option, and focus stays on the moved item.
  - Shortcuts are exposed through `aria-keyshortcuts`, and live regions confirm each action.
  - *Inference:* Alt+Left/Right would be the horizontal equivalent. APG does not specify it.
  - WCAG 2.5.7 (AA) requires a **single-pointer, non-drag** alternative to dragging, and says keyboard support alone does not satisfy it (https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).

## 2. Radix vs Base UI vs shadcn

**Radix Tabs** (https://www.radix-ui.com/primitives/docs/components/tabs)
- Props:
  - Root: `activationMode` (automatic | manual, default automatic), `orientation`, `dir`, `value` / `defaultValue` / `onValueChange`.
  - List: `loop` (default true).
  - Content: `forceMount`.
  - `asChild` on every part.
- Data attributes: `data-state`, `data-orientation`, `data-disabled`.
- Behaviour read from source (https://github.com/radix-ui/primitives/blob/main/packages/react/tabs/src/tabs.tsx):
  - The Trigger is always a `button role="tab"` inside a `RovingFocusGroup.Item`.
  - A tab is selected on **mousedown**, left button only and not with Ctrl. Any other mouse button gets `preventDefault` and doesn't select.
  - `onKeyDown` ignores key events that don't come from the trigger itself (issue #3232).
  - **Gotcha:** Content computes `present = forceMount || isSelected` and sets `hidden={!present}`. With `forceMount`, inactive panels are therefore *not* hidden; you have to hide them yourself, e.g. `data-[state=inactive]:hidden`. Every tabpanel gets `tabIndex=0`.
- Status (https://www.radix-ui.com/primitives/docs/overview/releases):
  - Still getting releases; the latest entry is 20 Jul 2026 and adds per-primitive subpaths (`radix-ui/accordion`).
  - The unified `radix-ui` package has existed since Jan 2025.
  - The last Tabs-specific changelog entry is from 2022 (v1.0).

**Base UI Tabs 1.8.0** (https://base-ui.com/react/components/tabs)
- API:
  - Root: `value`, and `onValueChange(value, eventDetails)`. `eventDetails.reason` is `'none' | 'initial' | 'disabled' | 'missing'`.
  - List: `activateOnFocus`, which **defaults to false** (manual activation, the reverse of Radix), and `loopFocus` (true).
  - Tab: `nativeButton` and `render`.
  - Panel: `keepMounted` (false).
- **Tabs.Indicator** exposes `--active-tab-left/top/right/bottom/width/height`, and elements carry `data-activation-direction`. The docs give no example CSS for animating it.
- If the selected tab is removed, it fires `onValueChange` with reason `'missing'` and falls back to an enabled tab. That makes it better suited than Radix to dynamic tab lists.
- 1.0.0 went stable on 11 Dec 2025. rc.0 changed `keepMounted` behaviour in a breaking way (https://base-ui.com/react/overview/releases).

**React Aria Tabs** (https://react-aria.adobe.com/Tabs)
- Offers `keyboardActivation`, dynamic `items`, an animated `SelectionIndicator` that respects reduced motion, and `shouldForceMount`, which keeps inactive panels mounted as inert.
- The Tabs docs don't cover closing or drag-and-drop.

**shadcn/ui**
- The Tabs docs offer Base UI, Radix and React Aria versions (https://ui.shadcn.com/docs/components/tabs).
- The July 2026 changelog made Base UI the **default**; Radix stays supported and is not deprecated (https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default).
- Source (https://github.com/shadcn-ui/ui/tree/main/apps/v4/registry/bases):
  - Parts carry `data-slot` = `tabs`, `tabs-list`, `tabs-trigger`, `tabs-content`.
  - `TabsList` has a cva `variant: default | line`, mirrored into `data-variant`.
  - The line variant draws an `after:` underline on each trigger and fades it in with an opacity transition. **There is no sliding indicator.**
  - Styling uses named groups `group/tabs` and `group/tabs-list`, e.g. `group-data-[variant=line]/tabs-list:data-active:after:opacity-100`.
- `shadcn/tailwind.css` (https://github.com/shadcn-ui/ui/blob/main/packages/shadcn/src/tailwind.css):
  - Defines `@custom-variant data-active`, which matches `[data-state=active]` or `[data-active]`, so one class works for both Radix and Base UI. It also defines `data-horizontal` and `data-vertical`.
  - Ships a `no-scrollbar` utility.
  - Ships `scroll-fade` / `scroll-fade-x` utilities: `mask-image` driven by `animation-timeline: scroll(self x)`, RTL-aware. Under `@supports not`, it falls back to a static fade.

## 3. React 19.2 / 19.3

- **`<Activity>`** has been stable since 19.2 (1 Oct 2025). In hidden mode it "hides the children, unmounts effects, and defers all updates" (https://react.dev/blog/2025/10/01/react-19-2).
- Reference (https://react.dev/reference/react/Activity):
  - Hidden children get `display:none`; their DOM and state are kept.
  - **Effects are destroyed and subscriptions cleaned up** while hidden.
  - Hidden children still re-render, at lower priority.
  - A boundary that starts hidden pre-renders its content without mounting Effects.
  - DOM side effects keep going (e.g. `<video>`, `<iframe>`); the docs say to pause them in a `useLayoutEffect` cleanup.
  - A hidden Activity whose child is text only renders nothing.
  - An Activity inside a `<ViewTransition>` plays enter/exit animations when revealed or hidden by a `startTransition` update.
  - The docs' main example is a tabbed UI.
  - React 19.3 includes Activity bug fixes.
- *Inference, and the key point for "work keeps running in the background":* any work owned by an Effect inside a hidden panel **stops**. Long-running work has to live outside the panel subtree (a store or service) with the panel subscribing to it. Hiding with CSS or the `hidden` attribute keeps Effects mounted, but you lose Activity's lower-priority rendering.
- **Transitions** (https://react.dev/reference/react/useTransition): the docs use tab switching as the example. A second click interrupts a pending switch, and `isPending` can drive a pending state on the tab.
- **Suspense** (https://react.dev/reference/react/Suspense):
  - During a Transition, React doesn't swap already-shown content for a fallback.
  - No state is kept for trees that suspended before their first mount.
  - Use `key` to reset a boundary.
- **`useDeferredValue`** (https://react.dev/reference/react/useDeferredValue): the background re-render can be interrupted, and it shows stale content instead of a fallback.
- **Error boundaries** (https://react.dev/reference/react/Component):
  - Still class-only ("no direct equivalent … in function components yet").
  - They don't catch errors in event handlers or async code.
  - The docs advise choosing granularity by where an error message makes sense. That supports one boundary per panel.
- **`<ViewTransition>`:**
  - The 19.3 blog (9 Sep 2026) says it is **stable**, along with `addTransitionType` and Fragment refs (https://react.dev/blog/2026/09/09/react-19-3).
  - Only transitions (`startTransition`, `useDeferredValue`, Suspense) trigger it.
  - `name` must be unique app-wide, and the component must come before any DOM node.
  - `share` handles named pairs, which fits a sliding indicator.
  - DOM only. You must add `prefers-reduced-motion` handling yourself (https://react.dev/reference/react/ViewTransition).

## 4. Drag-and-drop reordering

**Pragmatic drag and drop** is built on native HTML5 drag-and-drop.
- **Import paths changed.**
  - 3.0.0 (Aug 2026) added direct entry points: `@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter` and `/utils/reorder`.
  - In 4.0.0, the old `/element/adapter` still exists but is marked `@deprecated` (checked in the package tarball).
  - Hitbox 2.2.2 deprecated the `/closest-edge` barrel in favour of `/closest-edge/attach-closest-edge`, `/closest-edge/extract-closest-edge` and `Edge` from `/types`.
- For a horizontal strip, `attachClosestEdge` takes `allowedEdges`, e.g. `['left','right']`. The newer **list-item** hitbox (`reorder-before` / `reorder-after` / `combine`) is now the recommended one. `util` provides `getReorderDestinationIndex` and `reorderWithEdge` (https://atlassian.design/components/pragmatic-drag-and-drop/optional-packages/hitbox/about).
- `autoScrollForElements` takes `getAllowedAxis`. The docs warn that the browser's built-in auto-scroller still scrolls every axis, so also set `overflow-y: hidden` (https://atlassian.design/components/pragmatic-drag-and-drop/optional-packages/auto-scroll/about).
- Accessibility guidance (https://atlassian.design/components/pragmatic-drag-and-drop/accessibility-guidelines):
  - Don't rely on arrow-key dragging; give menu or button actions with explicit outcomes, e.g. "Move to top".
  - Live-region messages should give the item name plus its old and new position.
  - Return focus to the trigger after a move.
  - All examples are vertical lists.

**dnd-kit:** the new `@dnd-kit/react` is still pre-1.0 (0.5.0).
- From the migration guide (https://dndkit.com/react/guides/migration):
  - `DragDropProvider` replaces `DndContext`.
  - `useSortable` now comes from `@dnd-kit/react/sortable` and needs no `SortableContext`.
  - Sorting strategies, including horizontal, are "handled automatically".
  - `move` from `@dnd-kit/helpers` replaces `arrayMove`.
  - Pointer and keyboard sensors are on by default.
- The Accessibility plugin is on by default. It sets `aria-roledescription="draggable"`, adds a `role=status` live region with default announcements, and is configured with `Accessibility.configure()` (https://dndkit.com/extend/plugins/accessibility/).
- The legacy `@dnd-kit/core` hasn't been published since Dec 2024.

**Neither library documents a tab-strip recipe.**

## 5. Overflow patterns and expected affordances

**VS Code settings**, taken from `workbench.contribution.ts` on main (https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/workbench.contribution.ts). Default in parentheses.

| Setting | Values (default) |
| --- | --- |
| `workbench.editor.showTabs` | multiple \| single \| none (multiple) |
| `wrapTabs` | (false) |
| `tabSizing` | fit \| shrink \| fixed (fit) |
| `tabSizingFixedMinWidth` / `tabSizingFixedMaxWidth` | 50 / 160 (minimum allowed 38) |
| `pinnedTabSizing` | normal \| compact \| shrink (normal) |
| `pinnedTabsOnSeparateRow` | (false) |
| `preventPinnedEditorClose` | keyboardAndMouse \| keyboard \| mouse \| never — names "mouse middle click" as a close gesture |
| `tabActionLocation` | left \| right (right) |
| `tabActionCloseVisibility` / `tabActionUnpinVisibility` | (true) |
| `tabActionReserveSpace` | (true) |
| `highlightModifiedTabs` | (false) |
| `titleScrollbarSizing` | default \| large |
| `titleScrollbarVisibility` | auto \| visible \| hidden |
| `scrollToSwitchTabs` | (false) |
| `showTabIndex` | (false) |
| `openPositioning` | left \| right \| first \| last (right) |
| `focusRecentEditorAfterClose` | (true = MRU order) |
| `enablePreview` | (true; preview tabs shown in italics) |
| `limit.enabled` / `limit.value` | false / 10 |
| `dragToOpenWindow` | (true) |

All names after the first row are under `workbench.editor.`.

**VS Code shortcuts**
- ⌘W closes (Ctrl+F4 on Windows); ⇧⌘T reopens a closed editor; Ctrl+Tab steps through editor history (MRU) (https://code.visualstudio.com/docs/reference/default-keybindings).
- `nextEditor` is Ctrl+PgDn, or ⌘⌥→ / ⇧⌘] on Mac.
- `openEditorAtIndex1–9` is Alt+N on Windows/Linux and ⌃N on Mac. Cmd/Ctrl+1–8 focus editor *groups*, not tabs (source: `editorCommands.ts`, `editorActions.ts`).
- Double-clicking an empty tab area creates a new file (https://code.visualstudio.com/docs/getstarted/userinterface).

**Chrome**
- Ctrl+Tab / Ctrl+PgDn go to the next tab by **position**, not recency. Ctrl/⌘+1–8 jump to a tab and 9 to the last. Ctrl+Shift+PgUp/PgDn move a tab. Ctrl/⌘+Shift+T reopens tabs in the order they were closed.
- Double-clicking a blank tab-strip area maximizes or restores the window (https://support.google.com/chrome/answer/157179). This **conflicts** with VS Code's double-click-for-new-tab.
- Pinned tabs are smaller and show only the icon. Tab Search is Ctrl/⌘+Shift+A (https://support.google.com/chrome/answer/2391819).

**Zed** (https://zed.dev/docs/reference/all-settings): `tabs.close_position` (right), `show_close_button` hover \| always \| hidden (default hover), `activate_on_close` history \| neighbour \| left_neighbour.

**Electron gotcha:** the `close` menu role's default accelerator is `CommandOrControl+W`. `fileMenu` includes it on macOS and `windowMenu` on Windows/Linux (https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_menu_roles.cc). The app menu has to be overridden for Cmd/Ctrl+W to close a tab instead of the window.

## 6. Tailwind v4.3 idioms

Sources: https://tailwindcss.com/docs/hover-focus-and-other-states, https://tailwindcss.com/docs/responsive-design, https://tailwindcss.com/docs/functions-and-directives

- **State variants:**
  - `data-active:` and `data-[state=active]:`.
  - `aria-selected:` is built in.
  - Named groups, e.g. `group/tabs` with `group-hover/tabs:`, and `group-aria-[…]:`.
  - `in-*` gives an implicit group without a `group` class.
  - `not-*`, e.g. `hover:not-focus:`.
  - `has-*` and arbitrary variants, including at-rule forms like `[@supports(...)]:`.
- **Custom code:**
  - `@custom-variant name { …@slot }`.
  - `@variant` inside CSS; 4.3 adds stacked and compound forms.
  - `@utility`, with `--value()`; 4.3 adds `--default()` (https://tailwindcss.com/blog/tailwindcss-v4-3, 8 May 2026).
- **Container queries:**
  - `@container`, `@container/name`, `@sm/name:`, `@max-md:`, `@sm:@max-md:`, `@min-[475px]:`, `@max-[960px]:`, and `@container-size` (new in 4.3).
  - The `@[300px]/name` syntax in the question does **not** appear in the v4 docs; the documented arbitrary form is `@min-[…]`.
- **Scrollbars (4.3):** `scrollbar-none/thin/auto`, `scrollbar-thumb-*` / `scrollbar-track-*`, `scrollbar-gutter-*`.
- **Edge masks:** `mask-x-from-*` / `mask-x-to-*` and `mask-l-from-*` / `mask-r-from-*` (https://tailwindcss.com/docs/mask-image).
- **Scroll-state queries** are **Chromium-only**. Per MDN browser-compat-data (https://github.com/mdn/browser-compat-data):
  - `container-type: scroll-state` with `scrollable`, `snapped` and `stuck` arrived in Chrome 133; `scrolled` arrived in Chrome 144.
  - Firefox and Safari have none of them (also https://web-platform-dx.github.io/web-features-explorer/features/container-scroll-state-queries/, "Limited availability").
  - Tailwind has no built-in variant for them; you'd define one with `@custom-variant`.
  - Caveat: these queries only style *descendants* of the scroll container (https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Conditional_rules/Container_scroll-state_queries). A mask on the scroller itself therefore can't be driven by one. shadcn's `scroll-fade-x` uses scroll-driven animations instead.
- **Scroll-driven animations** (`animation-timeline`): Chrome 115 and Safari 26; Firefox only in "preview".
- **`::scroll-button()`**: Chrome 135, experimental.

## 7. Moving the active-tab indicator

- **Anchor positioning** (BCD):
  - `anchor-name`, `anchor()` and `anchor-size()`: Chrome 125, Firefox 147, Safari 26. MDN shows a "Baseline 2026 newly available" banner (https://developer.mozilla.org/en-US/docs/Web/CSS/anchor-name).
  - `anchor()` is animatable in Chrome and Safari, not Firefox.
- **`interpolate-size` / `calc-size()`**: Chrome 129 only, marked experimental (https://developer.mozilla.org/en-US/docs/Web/CSS/interpolate-size).
- **View transitions:**
  - Same-document transitions have been Baseline since 2025-10-14, when Firefox 144 added them (https://web-platform-dx.github.io/web-features-explorer/features/view-transitions/).
  - `view-transition-class`: Chrome 125, Firefox 144, Safari 18.2.
  - `view-transition-name: match-element`: Chrome 137.
  - Element-scoped `Element.startViewTransition`: Chrome 147 only, experimental.
- **Electron 44 (Chromium 152)** has everything in sections 6 and 7. For the web build, Base UI's measured `--active-tab-*` variables or React Aria's `SelectionIndicator` need no new browser features.

---

## Conflicts and things I couldn't verify

1. **ViewTransition status.** The 19.3 blog says stable, but the reference page's sandboxes still pin `19.3.0-canary-…-20260904`. I treated the blog as authoritative.
2. **Anchor positioning support.**
   - MDN/BCD list Chrome 125, Firefox 147 and Safari 26.
   - The web-features explorer lists Chrome as "Not supported" (8 open bugs) and only Safari 27 (2026-09-14) as supported. The likely reason is that the feature group as a whole isn't fully conformant, but that's unconfirmed.
   - BCD also dates the `position-anchor` property to Chrome/Firefox 151, while `position-anchor: auto` is Chrome 127. That looks like a spec re-shape; test before relying on it.
3. **Pragmatic dnd docs lag the package.** atlassian.design still shows `/element/adapter` and `/closest-edge`, which are deprecated in the 4.0.0 / 3.0.0 packages.
4. **Chrome tab overflow.** Chrome Help doesn't document its shrink behaviour. Third-party reports say the `#scrollable-tabstrip` flag was removed in Chrome 144; the Chromium issue (https://issues.chromium.org/issues/475853506) needs sign-in and I couldn't read it. Unverified.
5. **Not researched.** Linear and Arc have no primary docs I could find. I did not consult the Apple HIG. Chrome hover cards and middle-click-to-close aren't in Chrome Help; VS Code's `preventPinnedEditorClose` does confirm middle-click closes tabs there.
6. **Inferences, not source statements:** the mouse-only close-button pattern (§1), Alt+Left/Right for keyboard reordering (§1), and "Activity stops Effect-owned background work, so move that work out of the panel" (§3).
