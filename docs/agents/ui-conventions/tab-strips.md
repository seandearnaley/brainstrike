# Tab strips — evidence

Supports `docs/agents/ui-conventions.md` § "TAB STRIPS".
Read before changing tab-strip geometry, activation, the close affordance, overflow or the strip's menus.

---

- **2026-09-27 audit (origin/main 450c4280e).** Four strips were measured live with Playwright on a `vite preview` build. Tab heights were 20/24/27/28/33/40px and radii 0/4/6px; font weights differed between strips, and the Git tabs changed weight on selection. axe-core 4.13 `aria-required-children` failed on the assistant and workspace tablists (close buttons were owned by the tablist); Radix Library tabs passed.
- **Automatic activation reloaded workspaces.** Arrow roving in the assistant strip called `openThreadTab`, and `ThreadWorkspaceCoordinator` keys its hydration on `activeThreadId`, so each arrow press reloaded a saved workspace. This is why activation is manual everywhere (D3).
- **React registers `onWheel` passively**, so the old `preventDefault` in the assistant strip's `onWheel` never took effect. The strip now uses a native non-passive listener.
- **`<Activity>` is not a free keep-alive.** A hidden `<Activity>` unmounts effects. `assistant-ui-panel-wrapper.tsx` subscribes to tool updates in an effect, so root thread panels stay `hidden`-mounted. Child conversations deliberately use `<Activity>` (#3292).
- **`useSyncExternalStore` updates always render blocking** (react.dev caveat), so a zustand-driven tab switch gains nothing from `startTransition` or `<ViewTransition>`. There is no sliding indicator.
- **`onMenuOpenChange` exists for native views (BST-1837, for BST-1840).** The browser pane draws an Electron `WebContentsView` above the renderer, so a Radix menu opened from its strip paints behind the page unless the host occludes the view while any strip menu (tab, strip background or All-tabs) is open.
- **`statusLabel` may stand alone.** Thread tabs carry an identity mark that draws its own badge, and their "finished, unseen" state has no `TabStatus`; the accessible name still needs the text, so it is `statusLabel ?? default text for status`.
- **Sources:** `docs/superpowers/research/2026-09-27-tab-controller-vendor-research.md`. Spec: `docs/superpowers/specs/2026-09-27-unified-tab-controllers-design.md`.
