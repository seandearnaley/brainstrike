# Unified Tab Controllers — Design

**Date:** 2026-09-27
**Status:** Approved 2026-09-27 — every decision D1–D9 taken as recommended (§10).
**Epic:** BST-1836 · children BST-1837 (primitives), BST-1838 (assistant), BST-1839 (workspace), BST-1840 (browser pane), BST-1841 (view switchers), BST-1842 (chords + commands)
**Scope:** every tab surface in `apps/web` and `apps/desktop`

## 1. Problem

Brainstrike has eight tab surfaces built four different ways:

- two hand-rolled document strips of about 250 lines each, which have drifted apart;
- a bare browser-pane row with no keyboard support;
- Radix segmented switchers;
- a bespoke Git underline.

As a result, tabs that sit side by side paint at different heights, spacing, radii, weights, close affordances and selection idioms. They respond differently to the same key, and only some of them have a right-click menu. Two robustness gaps sit underneath this:

- no error boundary isolates a workspace panel;
- arrow-key roving in the assistant strip reloads a saved workspace on every keypress.

The user asked for:

- one consistent, world-class tab controller whose components are purely visual;
- correct spacing;
- right-click menus everywhere;
- full keyboard control;
- modern React idioms;
- tab switching that is safe while work is running.

## 2. Goals and non-goals

Goals:

1. **One primitive set.** `packages/ui/src/tab-strip/` holds presentation and the generic interaction mechanics. It has no stores, no domain types and no feature imports.
2. **One visual token set.** Geometry, typography, states, focus and motion are shared by document strips and view switchers.
3. **One interaction model.** Keyboard follows WAI-ARIA APG; pointer covers click, middle-click, drag and right-click; focus restoration and the context-menu contract are shared.
4. **One runtime policy.** Keep-alive, `<Activity>`, transitions, Suspense and per-panel error isolation follow written rules, each with evidence.
5. **Consumers become thin adapters.** Each maps its store to the primitives. Business rules stay where they are today.

Non-goals:

- New thread, file or app domain behaviour.
- Adopting Base UI or React Aria.
- Bumping pragmatic-drag-and-drop to 4.0.0.
- Vertical tabs.
- Tab groups or "split editor".
- Moving run ownership out of panels.
- `<Activity>` on panels whose effects own work that must continue.

## 3. Current state (audit, origin/main `450c4280e`)

I measured live with Playwright against a `vite preview` build at 1600×1000, reading computed styles. The full per-surface table is in BST-1836. The drift that matters:

| Property | Assistant threads | Workspace app | Workspace file | Segmented (Library, Explorer/Search) | Git | Browser pane |
| --- | --- | --- | --- | --- | --- | --- |
| Strip height / inline padding | 36 / 8+8 | 36 / 0+8 | 36 / 0+8 | 36 / 8+8 | 40 / 0 | 32 / 4 |
| Tab height | 28 | 27 | 33 (35 shell) | 20 in a 28 track | 40 | 24 |
| Radius | 6 | 6 | 0 (2px bottom border) | 4 | 0 | 4 |
| Gap | 4 | 2 | 2 | grid | grid | 4 |
| Label weight | 400 | 500 | 400 | 500 | 400 → 500 when active (width jitter) | 400 |
| Selected | identity tint | `primary/10` | underline + `bg-background` | raised `bg-background` | 2px bar | `bg-muted` |
| Close | 20px, hover or active | 20px, hover or active | **24px, always** | — | — | 12px icon, no name |
| Overflow | chevrons always shown (disabled) | chevrons only when overflowing | same | — | — | none |
| Activation | **automatic** | manual | manual | automatic / manual | automatic | none |
| Reorder | drag, ⌥⇧←/→, menu | — | — | — | — | — |
| Right-click | 6 actions | **none** (by ruling) | 4 actions | — | — | — |

Defects confirmed in code:

1. **Close buttons fail axe.** They sit inside `role=tablist` as screen-reader-visible buttons. **axe-core 4.13 on the live build confirms it:** `aria-required-children` fails on the assistant and workspace tablists with "children which are not allowed: button[aria-label]", while the Radix Library tablist passes. ARIA gives `tab` presentational children, and HTML forbids interactive descendants inside `<button>` (§13 [1]–[3]).
2. **Automatic activation reloads workspaces.** `handleTabKeyDown` calls `openThreadTab` on every arrow press, and `ThreadWorkspaceCoordinator` (`thread-workspace/thread-workspace-coordinator.tsx`) keys its workspace reload on `activeThreadId`.
3. **Two identical chevrons.** The workspace header's hide button is a `ChevronRight` (`packages/ui/src/layout/ide-layout.tsx`) sitting next to the strip's own `ChevronRight` scroll button.
4. **No error isolation for workspace panels.** Nothing catches errors in `WorkspaceBody` app panels, `FileTabBody` (apart from the markdown preview), or either strip. `createRoot` has no `onUncaughtError`, so one render error unmounts the app. Assistant thread panels do have `AssistantPanelErrorBoundary`.
5. **Hand-built hiding for keep-alive panels.** Radix `TabsContent forceMount` leaves inactive panels visible ([5]). `agent-sidebar-panel.tsx` and `explorer-search-tabs.tsx` each hand-roll a "mounted-once latch + `forceMount` + `hidden`" pattern.
6. **Duplicated mechanics.** Overflow measurement, wheel mapping, reduced motion, roving focus and close focus restoration exist twice. Drag and drop exists only in `app-shell`, which `file-explorer-ui` cannot import.
7. **Undocumented container-query syntax.** The `@[300px]/name` form compiles in Tailwind 4.3 (verified in the built CSS: `@container assistant-tabs (width>=300px)`) but does not appear in the v4 docs. New code uses `@min-[…]/name` ([9]).

## 4. Architecture

```
@brainstrike/ui/tab-strip        presentational + generic mechanics (no stores, no domain)
  TabStrip, TabStripTab, TabStripAllTabsMenu, TabPanelBoundary
  useTabStripKeyboard, useTabStripOverflow, useTabStripReorder (pragmatic-dnd 3.x)
  tab-strip-tokens.ts
@brainstrike/ui/tabs             fixed view switchers (Radix Tabs) sharing the same tokens
@brainstrike/context-actions     createTabStripActions(kind, ops): the standard tab action set
feature adapters (thin)          app-shell: assistant strip, browser strip
                                 file-explorer-ui: workspace strip
                                 each maps store → items/callbacks/targets, owns no visuals
```

**Dependency direction.** `ui` gains the pragmatic-dnd packages at the same 3.x versions app-shell uses. It stays a leaf: it imports no feature package. `file-explorer-ui` gets reorder through `ui`, which it could not do while the drag-and-drop code lived in app-shell. The `pragmatic-dnd-single-core` script guard already fails if two physical copies appear.

**"Purely visual" means precisely this:**

- The primitives receive data and callbacks and emit intents: `onActivate`, `onClose`, `onReorder` and `getContextTarget`.
- They own DOM mechanics: roving focus, overflow, drag and drop, and menu anchoring.
- They never read or write a store, never decide what closing means, and never import a domain type.

**Data-driven API.** Dynamic lists are standard as data (React Aria's `items` [6]), and data lets the strip own ordering for keyboard, drag and drop and the All-tabs menu without registering children through context:

```ts
type TabStatus = 'running' | 'attention' | 'error' | 'loading' | 'locked' | 'deleted';

interface TabStripItem {
  readonly id: string;
  readonly label: string;               // visible text; truncates
  readonly accessibleLabel?: string;     // defaults to label + status text
  readonly icon?: ComponentType<{ className?: string }>;
  readonly mark?: ReactNode;             // identity mark (thread/agent); status badges its corner
  readonly status?: TabStatus;
  readonly statusLabel?: string;         // e.g. "needs your input"
  readonly closable: boolean;
  readonly appearance?: TabAppearance;   // { idleClassName, selectedClassName, markClassName?, style? }
  readonly tooltip?: string;
  readonly tabDomId: string;             // stable, consumer-owned (existing test ids survive)
  readonly panelDomId: string;           // aria-controls
  readonly testId?: string;
}

interface TabStripProps {
  readonly 'aria-label': string;
  readonly pinnedItems?: readonly TabStripItem[];   // non-scrolling, not reorderable
  readonly items: readonly TabStripItem[];          // scrolling
  readonly activeId: string | null;
  readonly onActivate: (id: string) => void;
  readonly onClose?: (id: string) => void;          // absent ⇒ no close affordance anywhere
  readonly onReorder?: (orderedIds: readonly string[]) => void; // absent ⇒ no DnD/⌥⇧ arrows/Move items
  readonly contextMenu?: {
    readonly controller: ContextMenuTargetController;
    readonly localActions: readonly AnyContextAction[];
    readonly getTabTarget: (id: string) => ContextTarget | null;
    readonly getStripTarget?: () => ContextTarget | null;
  };
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;                    // e.g. New / Add-app menu
  readonly allTabsMenu?: boolean;                   // default true
}
```

Tabs memoize on item field equality, so consumers don't have to keep item objects stable. Handlers passed down are stable strip-level functions built with `useEffectEvent`, which is stable in React 19.2.

## 5. Visual system (tokens)

Everything lives in `tab-strip-tokens.ts` as literal class strings. The Tailwind scanner must see literals: this is the same rule as `layers.ts` [9].

| Token | Value | Notes |
| --- | --- | --- |
| Strip | `h-9` (36) · `px-1.5` (6) · `gap-1` (4) · `border-b` · `bg-muted/30` | Matches `IdeLayout` panel headers. The assistant strip moves from `/20` to `/30`. |
| Document tab | `h-7` (28) · `rounded-md` (6) · `pl-2 pr-1` · `gap-1.5` | Every strip. |
| Width (document) | `min-w-24` (96) · `max-w-56` (224); label `truncate` with tooltip | VS Code-style "fit" sizing; overflow scrolls ([12] `tabSizing`). |
| Pinned app tab | intrinsic; icon-only below `@max-[520px]/tab-strip` | Keeps its name through tooltip and accessible label. The threshold is pinned by the geometry E2E. |
| Label | `text-xs` (12/16) · `font-medium` for every state | State changes colour, never weight, so no width jitter. |
| Icon / mark / status | icon `size-3.5` (14) · mark `size-5` (20) · status badge 12 in the mark's corner | Status sits with the icon (§5.1). |
| Close | `size-5` (20) + `after:-inset-1` hit area; slot always reserved | Visibility changes opacity only, so no layout shift. |
| Idle | transparent, or the identity `idleClassName`; `text-muted-foreground` | |
| Hover | `bg-muted/60` · `text-foreground` | |
| Selected (neutral) | `bg-background text-foreground shadow-xs ring-1 ring-border/70` | The same "raised surface" as the segmented trigger. One selection language everywhere. |
| Selected (identity) | the consumer's `selectedClassName` tint (threads, agents) | Existing colour contract in `assistant-thread-presentation.ts`. |
| Focus | `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset` | Inset, because the scroller would clip an outer ring. |
| Motion | `transition-[color,background-color,box-shadow,opacity] duration-150 motion-reduce:transition-none` | No sliding indicator (§7.5). |
| Segmented switcher (`sm`) | track `h-7 rounded-md bg-muted p-0.5`; trigger `h-6 rounded-[calc(var(--radius-md)-2px)] text-xs font-medium px-2` | Same radius family, focus ring and selected surface as document tabs. |
| Segmented switcher (`md`) | track `h-9`; trigger `h-8 text-sm px-4` | Full pages only (Settings). |

### 5.1 Anatomy

```
┌ strip h-9 ──────────────────────────────────────────────────────────────────────┐
│ [leading] │ [pinned: ◧ Files ✕][◧ Changes] ┊ [scroll ⟨fade⟩ ◉ Thread A ✕ | ▣ b.ts ✕ ⟨fade⟩] │ [+][⌄] │
└──────────────────────────────────────────────────────────────────────────────────┘
tab: [icon|mark(+status badge)] [label………] [close slot 20px]
```

- **Status placement.** Status sits with the icon, never in the close slot.
  - A tab with a mark shows a corner badge, reusing `thread-row-status-glyph.tsx` geometry so a thread tab and its Threads-panel row read as the same control (BST-939).
  - A tab with a plain icon has the icon replaced by the status icon. This is today's `FileTabIcon` behaviour for loading, locked and deleted.
  - The accessible name gets the status text, e.g. "gamma.md, deleted".
- **Close visibility.** Visible when hovered, when focus is within the tab, and always on the active tab. Otherwise the button is at 0 opacity with pointer events off, and its slot stays reserved.

### 5.2 Overflow (decision D2)

The recommendation has four parts:

- **No chevrons.** Overflow is handled by:
  1. wheel-to-horizontal scrolling, clamped and with default prevented;
  2. `scrollIntoView({ inline: 'nearest' })` on activate and on focus;
  3. **edge fade masks** driven by `data-overflow-start` / `data-overflow-end` attributes from the overflow hook, which work on every browser;
  4. an **"All tabs" menu** (`⌄`) that is always present in the trailing region.
- **The All-tabs menu** lists every tab (pinned first) with its icon and status. It supports type-ahead, activates on select, and hosts the strip-level bulk actions (Close All, and Reopen Closed once BST-1842 lands).
- **Focus is never hidden.** `scroll-padding-inline` ≥ the mask width guarantees the focused tab is never covered by a fade (WCAG 2.4.11 [4]).
- **Precedent:** VS Code and Chrome ship no chevrons, and Fluent 2 and Primer move overflow into a menu [4].

Chevrons today either reserve 56px permanently (assistant) or shift the layout when they appear (workspace). They also look identical to the panel-collapse chevron (defect 3).

## 6. Interaction model

### 6.1 DOM and ARIA

```html
<div data-slot="tab-strip" class="@container/tab-strip …">
  {leading}
  <div role="tablist" aria-label="…" aria-orientation="horizontal">   <!-- tabs only -->
    <div role="presentation" data-group="pinned">…</div>
    <div role="presentation" data-group="scroll" data-overflow-start data-overflow-end>
      <div role="presentation" data-slot="tab-shell" data-state="active|inactive">
        <button role="tab" id aria-selected aria-controls tabindex="0|-1"
                aria-keyshortcuts="Delete" aria-haspopup="menu">…label…</button>
        <button aria-hidden="true" tabindex="-1" data-slot="tab-close">✕</button>
      </div>
    </div>
  </div>
  {trailing}   <!-- New, All-tabs menu: outside the tablist -->
</div>
```

- The close button is a **mouse-only sibling** (`aria-hidden`, `tabIndex=-1`). Keyboard and assistive-technology users close with Delete or the menu, as APG describes ([1]).
  - This is an inference from ARIA, HTML and axe rules; it is not stated verbatim by APG.
  - Trade-off: voice-control users can't target the ✕ by name. They can say "Close" through the context menu.
- `aria-haspopup="menu"` goes on tabs that have a context menu, following APG's popup-menu note [1].

### 6.2 Keyboard (inside a strip)

| Key | Action | Source |
| --- | --- | --- |
| ← / → | move focus, wrapping (pinned group and scroll group form one sequence) | APG [1] |
| Home / End | first / last tab | APG [1] |
| Enter / Space | activate the focused tab (**manual activation**, D3) | APG [1] |
| Delete | close the focused tab; focus moves to the next tab, or the previous one if it was last; with no tabs left, focus goes to the strip's New control | APG [1] |
| ⌥⇧← / ⌥⇧→ | move the tab (reorderable strips only); focus stays on it; a live region announces name and old/new position | APG rearrangeable listbox [2], PDnD a11y [7] |
| Shift+F10 / ContextMenu | open the focused tab's menu; focus returns to the tab when the menu closes | APG [1] |
| Tab | leave the strip to the active panel | APG [1] |

Verification item for BST-1837: Chromium sends a `contextmenu` event for Shift+F10 and the ContextMenu key. The test must assert that the menu **anchors at the tab**. If the synthetic event carries pointer coordinates of (0,0), the strip dispatches a positioned `contextmenu` from the tab's rect instead.

### 6.3 Pointer

- **Click** activates.
- **Middle-click** (`auxclick`, button 1) closes when the tab is closable. VS Code treats middle-click as a close gesture [12].
- **Drag** reorders within the scroll group when `onReorder` exists. It uses pragmatic-dnd closest-edge on left/right, x-axis-only auto-scroll with `overflow-y: hidden` ([7]), and a 2px drop indicator. Pinned tabs don't drag.
- **Right-click** on a tab opens the tab menu. Right-click on the empty strip background opens the strip menu.
- **Double-click on the empty strip does nothing.** VS Code (new tab) and Chrome (maximize window) disagree [12], so we don't guess.

### 6.4 Context menus (decision D4)

The context action contract in `docs/agents/ui-conventions.md` still applies. The strip encapsulates its mechanics:

- claim the target synchronously in `contextmenu` through `controller.setTarget(getTabTarget(id))`;
- reset it in `onContextMenuCapture` on the container;
- wrap the strip in `ActionContextMenu`;
- pass `onCloseAutoFocus` so focus returns to the origin tab while it is mounted, and otherwise goes to the active tab. Focus never falls to `body`.

**Tab menu** = the local tab-management group from `createTabStripActions` plus the global actions registered for that target kind (thread tabs: Copy Title / Copy ID; file tabs: the `file-entry` actions). The group contains:

- Close
- Close Others
- Close to the Right
- Close All
- ─
- Move Left
- Move Right (reorderable strips only)

Every run re-checks its target against the live store and resolves to an `ActionOutcome`.

**Strip background menu:** a new generic target `{ kind: 'tab-strip', stripId }` with local actions:

- New (where the strip has one)
- Close All
- Reopen Closed Tab (BST-1842)

**Target kinds:**

| Kind | Status |
| --- | --- |
| `assistant-thread-tab` | exists |
| `workspace-file-tab` | exists |
| `workspace-app-tab` | new; supersedes the "no context menu" ruling (§8.2) |
| `browser-tab` | new |
| `tab-strip` | new |

**Fixed view switchers get no context menu.** They have no action to offer, and a one-item or empty menu is noise. This is where the recommendation departs from "right-click on everything"; see D4.

## 7. Runtime behaviour

### 7.1 Keep-alive policy (one written rule per surface)

| Surface | Hidden strategy | Decision | Evidence |
| --- | --- | --- | --- |
| Assistant thread panels | mounted, `hidden` attribute | **keep** | Effects in `assistant-ui-panel-wrapper.tsx` own `subscribeAssistantToolUpdates` and runtime wiring. A hidden `<Activity>` unmounts effects [8], which would detach a background run's tool updates. |
| Workspace singleton apps | mounted on first activation, `hidden`, unmounted on close | **keep** | The Canvas iframe must not reload. The Terminal's pty subscription must stay attached. Closing the tab is the user's lever to release them (existing `workspace-body.tsx` contract). |
| Child conversations | `hidden` app panel wrapping an inner `<Activity>` | **keep** | PR #3292 pauses transcript subscriptions on purpose while keeping drafts; guarded by `delegated-workspace-app-activity.test.tsx`. |
| File tab bodies | only the active body is mounted, keyed by `compositeKey` | **keep** | Content is cached in the store and editor view state is persisted. |
| Library panels, Explorer/Search | Radix `forceMount` + hand latch + `hidden` | **`TabsContent keepMounted`** (same semantics, one implementation) | `<Activity>` adoption needs an effect audit and a test per panel, so it is not the default. |

**Rule.** `<Activity mode="hidden">` is correct only where every effect in the hidden subtree is presentation-only: a subscription whose loss while hidden is desired. Work that must continue in the background lives outside the panel, or the panel stays `hidden`-mounted.

### 7.2 Transitions

`useSyncExternalStore` updates cannot be non-blocking: React falls back to a blocking render when a store changes inside a transition ([8], `useSyncExternalStore` caveats). Every document strip's selection is a zustand store, so wrapping those switches in `startTransition` buys nothing. Their responsiveness comes from keep-alive (a switch toggles `hidden` and remounts nothing) and render isolation (§7.4).

Transitions are used where selection is React state. The Library switcher is one: its switch runs in `startTransition`, and the pending trigger shows `data-pending`.

### 7.3 Suspense and error isolation

- **Suspense.** Every lazily loaded panel (Search, Prompts, Collections) keeps its own `Suspense` boundary with one shared loading treatment.
- **`TabPanelBoundary`.** This is a class component, because error boundaries are still class-only [8]. It wraps every workspace app panel, the file body, and the Library panels. The fallback is panel-sized, with **Reload tab** (a reset key remounts the subtree) and **Copy details**. It logs through `createLogger('TabPanelBoundary')`.
- **Strip containment.** `TabStrip` also wraps itself, so a strip error degrades to a "Tabs unavailable — Retry" row instead of blanking the app.
- **Event-handler and async errors** are outside what boundaries catch. They keep going through `ActionOutcome` (toast + log).

### 7.4 Performance

- Selecting a tab re-renders exactly two tabs: the old active one and the new one. This rests on memoized `TabStripTab` with item-field equality and on stable handlers. A render-count test pins it.
- Status projections are list-wide sets from one live query each. The strip re-renders when a set changes, never per stream tick.
- Overflow state comes from a ResizeObserver on the scroller and its content, coalesced per frame. The hook sets state only when a boolean changes, which is the existing pattern.
- Drag and drop uses native HTML5 events. During a drag, only the hovered target tab re-renders, to draw its edge indicator.

### 7.5 Motion

There is no sliding active indicator.

- `<ViewTransition>` is stable in React 19.3 but animates only transition-triggered updates [8]. A zustand-driven selection is blocking, so it would never animate.
- An anchor-positioned indicator depends on anchor positioning, whose cross-browser status sources disagree ([10], research note 2).
- The raised selected surface cross-fades in 150ms and is off under `prefers-reduced-motion`.

## 8. Consumer migrations

### 8.1 Assistant threads (BST-1838)

- Rebuild `assistant-thread-tabs-workspace.tsx` on `TabStrip` as a thin adapter.
- **Manual activation.** This fixes the workspace reload on every arrow press (defect 2).
- **Status on each tab** comes from `resolveThreadRowStatusState` fed by three hooks: `hooks/use-threads-awaiting-approval.ts`, `use-active-assistant-thread-ids.ts` and `hooks/use-unseen-thread-ids.ts`.
- **Menu** from `createTabStripActions('assistant-thread-tab', …)`. The strip background offers New Thread and Close All.
- **Drag and drop moves.** `assistant-thread-tabs-dnd*.ts(x)` moves into `ui`, and app-shell keeps only the reorder callback.
- **Preserve:**
  - ids and test ids (`assistant-thread-tab-*`, `assistant-thread-panel-*`, `assistant-new-thread-button`);
  - the `hidden` keep-alive;
  - "New" with its container-query label, rewritten as `@min-[380px]/tab-strip`.
- **Characterise first, red before any change:**
  1. switching tabs while a scripted-model run streams elsewhere neither aborts the run nor throws;
  2. closing a running root thread's tab on web and on desktop. Current web behaviour is **unverified** and gets pinned before anything changes.

### 8.2 Workspace (BST-1839)

- **Groups.**
  - Pinned: singleton apps (Files, Changes, Canvas, Terminal, Worktree Map), in canonical order and not reorderable.
  - Scroll: dynamic child-conversation apps first, then file tabs.
  - `WorkspaceApp` gains a required `placement: 'pinned' | 'dynamic'`, so a new app cannot forget to choose.
- **Ruling superseded.** `docs/agents/ui-conventions.md` says "Workspace app tabs are … deliberately WITHOUT a context menu". Replace it with the tab-menu rule and record the change in `ui-conventions/context-action-layers.md` (maintainer request, 2026-09-27). The new `workspace-app-tab` target gets Close, Close Others and Close All. A bulk close keeps a selected pinned app, which is the existing multi-tab rule.
- **File reorder.** Drag, ⌥⇧ arrows, and menu Move Left/Right. It persists through `useTabManagerStore` (`tab-manager.v1`). If the persisted shape changes, add a `merge`-based migration and wire it into factory reset (`docs/agents/platform-contracts.md`). Reordering across the child-conversation/file boundary is **out of scope**.
- **Header.** The hide button uses the panel-close icon (defect 3).
- **Boundaries.** `TabPanelBoundary` goes around every app panel and the file body.

### 8.3 Browser pane (BST-1840, desktop)

- **Bridge.** It resolves through `resolveBrowserBridge()` (`window.browser`). Main-process tab state stays authoritative, and the re-seed on a rejected action is kept.
- **Menu:** Close, Close Others, Close All, Reload, and Duplicate (`createTab(tab.url)`).
- **No reorder:** the bridge has no reorder operation.
- **Occlusion.** Any menu that can overlap the native `WebContentsView` raises `setOccluded(true)` while it is open; otherwise it paints behind the native view.
- **New E2E spec.** No browser-pane desktop E2E exists today.

### 8.4 Fixed view switchers (BST-1841)

- **One `Tabs` component.** Refresh `tabs.tsx` with a cva `size: sm | md`, `data-slot` / `data-variant`, and shared tokens. It replaces `PANEL_TAB_TRIGGER_CLASS_NAME`.
- **`TabsContent keepMounted`** latches on first activation and hides inactive panels. It replaces the two hand-rolled copies.
- **Git.** `git-workbench-tabs.tsx` moves to `Tabs` and keeps its ids and count badge.
- **Activation.** Manual everywhere (D3).
- **Library** switches in a transition (§7.2).

## 9. Keyboard chords and palette commands (BST-1842)

| Chord | Platform | Action |
| --- | --- | --- |
| Ctrl+PgUp / Ctrl+PgDn | web + desktop | previous / next tab by position, in the focus-scoped strip (today: files only) |
| ⌘⌥← / ⌘⌥→ | macOS (web + desktop) | same as above (VS Code `nextEditor` [12]) |
| ⌘/Ctrl+W | desktop | close the active tab in the focus-scoped strip |
| ⌘/Ctrl+Shift+T | desktop | reopen the last closed tab (bounded in-memory history per strip) |
| Ctrl+Tab / Ctrl+Shift+Tab | desktop | next / previous (D7: positional vs MRU) |

- **Focus scope.** A chord acts on the strip whose panel contains `document.activeElement`. With focus in no panel, it acts on the workspace strip.
- **Web.** Browser-reserved chords (⌘W, ⌘T, Ctrl+Tab) stay unbound on web.
- **Electron.** The default `close` role binds CmdOrCtrl+W to closing the window [12], but this app's menu (`main.ts`, `application-file-menu.ts`) has no `close`, `fileMenu` or `windowMenu` role and no W accelerator, so ⌘W already reaches the renderer and BST-1842 adds no override. Should a role ever bind CmdOrCtrl+W, use the ⌘K/⌘P pattern: an accelerator that pushes a one-way IPC event to the renderer.
- **⌘K palette.** Add Close Tab, Reopen Closed Tab, Next/Previous Tab and Go to Tab…. Each is available only when its handler is wired.

## 10. Decisions for approval

| # | Decision | Recommendation | Alternative |
| --- | --- | --- | --- |
| D1 | Document tab idiom | **Raised pill** (28px, 6px radius): the neutral selected state is the segmented control's raised surface, and identity tabs keep their tint | VS Code flat tab with an underline |
| D2 | Overflow | **No chevrons**: fade masks + wheel + keyboard + auto-reveal + an always-present All-tabs menu | Chevrons shown consistently only on overflow (layout shift) or always reserved (56px) |
| D3 | Activation | **Manual everywhere** (Enter/Space). Arrows never trigger a workspace reload, a lazy chunk or a permission prompt | Automatic where panels are preloaded (APG allows it, but behaviour then differs between neighbouring strips) |
| D4 | Right-click scope | **Every document and app tab plus the strip background**; none on fixed view switchers | Also give switchers a menu (it would hold no real actions) |
| D5 | Pinned apps | **Pinned, non-scrolling group**, icon-only when narrow, still closable (✕, Delete, menu) | Apps scroll with everything else (today) |
| D6 | Close visibility | **Hover, focus-within and active**, slot always reserved | Always visible (today's file tabs) |
| D7 | Global chords | Table in §9; **Ctrl+Tab positional** (Chrome) | MRU (VS Code) |
| D8 | Mac Backspace | **Delete only** (APG), plus ⌘W and the menu | Backspace also closes a focused tab |
| D9 | ARIA regression guard | **Add `axe-core` as a devDependency** of `packages/ui` and assert `aria-required-children` / `nested-interactive` on `TabStrip` in unit tests. axe is the tool that caught defect 1. | Rely on hand-written role assertions only |

## 11. Testing

- **Red/green TDD** throughout.
- **`packages/ui` unit tests (happy-dom):**
  - ARIA structure and roving tabindex
  - every key in §6.2
  - focus after close (middle, last and only tab)
  - reorder announcement text
  - `createTabStripActions` staleness
  - boundary fallback and reset
  - render counts
- **`packages/ui` browser lane (real Chromium, WITH real Tailwind via `@tailwindcss/vite`):**
  - painted geometry (strip 36, tab 28, radius 6, 12px/500, close 20, gap 4)
  - axe `aria-required-children`, `nested-interactive`, `aria-hidden-focus` (D9)
  - Shift+F10 menu anchoring, native drag reorder, wheel mapping
  - colour tokens are NOT verified there (the `--color-*` theme mapping lives in the app entry); colour is verified on the built app
- **Web E2E, built preview:**
  - `tab-strip-geometry.test.ts` promotes the 2026-09-27 audit probe and asserts §5 tokens on every migrated strip against literal values.
  - Existing specs pass: `workspace-tabs`, `assistant-ui-panel`, `layout`, `layout-persistence`, `file-tab-pane`, `thread-workspaces`.
  - A mid-run tab switch is proven safe.
- **Desktop E2E:**
  - delegated child tab specs
  - the new browser-pane spec
  - ⌘W closes a tab, not the window (BST-1842)
- **Live verification (definition of done):** the running app, with screenshots at rest, on hover, with the menu open, while dragging, with a narrow container, with a crashed panel, and while a run is live.

## 12. Delivery

- **Stack:**
  - BST-1837 lands first.
  - BST-1838, BST-1839 and BST-1840 are siblings branched from BST-1837 and are rebased onto main once it lands.
  - BST-1841 is independent and branches from main.
  - BST-1842 follows BST-1838 and BST-1839.
- **One PR per ticket**, each independently green and within the review ceilings (300 files, 512 KiB).
- **Branches (Linear names):**
  - `seandearnaley/bst-1837-tabstrip-primitives-in-brainstrikeui-strip-tab-overflow` (carries this spec)
  - `seandearnaley/bst-1838-assistant-thread-tabs-on-the-shared-tabstrip-manual`
  - `seandearnaley/bst-1839-workspace-tab-strip-on-the-shared-tabstrip-pinned-apps`
  - `seandearnaley/bst-1840-browser-pane-tabs-on-the-shared-tabstrip-keyboard-model`
  - `seandearnaley/bst-1841-fixed-view-switchers-on-one-tabs-idiom-library`
  - `seandearnaley/bst-1842-tab-keyboard-chords-palette-commands-nextprev-close-reopen`
- **Living docs.** BST-1837 adds a "TAB STRIPS" section to `docs/agents/ui-conventions.md`, with evidence in `ui-conventions/tab-strips.md`. Each migration updates it in the same PR.
- **Risks:**
  - Extracting from large files will surface latent `react-hooks/*` findings: the React Compiler bails out on big components, so the eslint baseline is a floor. Budget for it and don't mistake it for a regression.
  - The pragmatic-dnd docs lag the 3.x/4.x packages [7]; follow the import paths the existing guard pins.

## 13. Sources (checked 2026-09-27)

1. WAI-ARIA APG Tabs — https://www.w3.org/WAI/ARIA/apg/patterns/tabs/ · ARIA `tab` presentational children — https://w3c.github.io/aria/#tab
2. APG rearrangeable listbox — https://www.w3.org/WAI/ARIA/apg/patterns/listbox/examples/listbox-rearrangeable/
3. HTML `<button>` content model — https://html.spec.whatwg.org/multipage/form-elements.html#the-button-element · axe `aria-required-children` — https://github.com/dequelabs/axe-core/blob/develop/lib/checks/aria/aria-required-children-evaluate.js
4. WCAG 2.4.11 — https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html · 2.5.7 — https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html · Fluent 2 tablist — https://fluent2.microsoft.design/components/web/react/core/tablist/usage · Primer — https://primer.style/product/components/underline-nav/
5. Radix Tabs — https://www.radix-ui.com/primitives/docs/components/tabs · source — https://github.com/radix-ui/primitives/blob/main/packages/react/tabs/src/tabs.tsx
6. Base UI Tabs — https://base-ui.com/react/components/tabs · React Aria Tabs — https://react-aria.adobe.com/Tabs · shadcn Tabs — https://ui.shadcn.com/docs/components/tabs
7. Pragmatic drag and drop (hitbox, auto-scroll, accessibility) — https://atlassian.design/components/pragmatic-drag-and-drop/
8. React — `<Activity>` https://react.dev/reference/react/Activity · 19.2 https://react.dev/blog/2025/10/01/react-19-2 · 19.3 https://react.dev/blog/2026/09/09/react-19-3 · `useTransition` https://react.dev/reference/react/useTransition · `useSyncExternalStore` https://react.dev/reference/react/useSyncExternalStore · error boundaries https://react.dev/reference/react/Component · `<ViewTransition>` https://react.dev/reference/react/ViewTransition
9. Tailwind v4.3 — https://tailwindcss.com/docs/responsive-design (container queries) · https://tailwindcss.com/docs/mask-image · https://tailwindcss.com/blog/tailwindcss-v4-3
10. MDN anchor positioning — https://developer.mozilla.org/en-US/docs/Web/CSS/anchor-name
11. Chrome shortcuts — https://support.google.com/chrome/answer/157179
12. VS Code settings (`workbench.contribution.ts`) — https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/workbench.contribution.ts · keybindings — https://code.visualstudio.com/docs/reference/default-keybindings · Electron menu roles — https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_menu_roles.cc

The full research notes, including unverified items and inferences, are in `docs/superpowers/research/2026-09-27-tab-controller-vendor-research.md`.
