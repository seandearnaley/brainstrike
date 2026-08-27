# W6 — Low-friction connection Implementation Plan (BST-1393)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the epic's last feature gap — *getting a folder INTO BrainStrike, and acting on one already there, without hunting for a picker*. Four pieces, spec §7 (**[D7]**, **[D10]**):

1. A **`workspace-root` ContextTarget** so the Explorer's per-root section header finally has a right-click menu — Set as main · New thread here · Copy path · Reveal · Open in Terminal · Disconnect… — closing the `docs/agents/workspace-context.md` DEFERRED ruling ("root headers have no ContextTarget kind yet"). Open in Terminal CONSUMES the BST-1457 seam that just landed.
2. A desktop **File menu**: **Open Folder…** (⌘O) and **Open Recent** built from main's own recent-roots ledger, plus `app.addRecentDocument` so the OS-level recents (macOS Dock menu / Windows jump list) work too.
3. **Drag a folder from Finder onto the composer** → connect it as a workspace folder.
4. **`brainstrike <path>` argv**, macOS **`open-file`**, and **`second-instance` argv** → open that folder.

**Architecture:** No new table, no new migration, no new main service, and — critically — **no new authorization door**. Every one of the four entry points converges on ONE renderer seam that calls the EXISTING picker-less grant (`fs:addRootByPath`, whose two ordered gates are the recent-roots ledger and the managed-worktree authorizer). A path that was never granted is **refused visibly, with a one-click "Add folder…" remedy that opens the real OS picker** — never silently mounted. Three new surfaces, one new bridge:

```
┌─ main (apps/desktop/src) ───────────────────────────────────────────────────┐
│ application-file-menu.ts (NEW, pure)  → File ▸ Open Folder… / Open Recent    │
│ folder-argv.ts           (NEW, pure)  → argv ⇒ candidate folder paths        │
│ workspace-open-queue.ts  (NEW)        → queue until a renderer says ready    │
│ main.ts: app.on('open-file') · second-instance(argv) · first-launch argv     │
│          menuTemplate gains the File submenu · app.addRecentDocument         │
├─ preload ───────────────────────────────────────────────────────────────────┤
│ window.workspace = { getDroppedPath, onOpenFolderPicker, onOpenPath }         │
├─ renderer (app-shell) ──────────────────────────────────────────────────────┤
│ workspace-connect/  workspace-connect-bridge.ts · use-connect-folder.ts       │
│                     workspace-connect-host.tsx (THE one seam)                │
│                     extract-dropped-folder-paths.ts (pure)                    │
│ context-action-registry.ts  += workspaceRootActions                          │
│ workspace-root-context-actions.tsx (Open in Terminal · New thread here)       │
├─ file-explorer-ui ──────────────────────────────────────────────────────────┤
│ context-actions/workspace-root-{target,actions,local-actions}.ts             │
│ shell/use-root-section-context-menu.ts + RootSection wraps its header         │
├─ assistant-ui (pure) ───────────────────────────────────────────────────────┤
│ workspace-bar/workspace-bar.tsx  += the folder drop zone (props only)         │
└─ context-actions ──────────────────────────────────────────────────────────┘
  types.ts: ContextTarget gains `workspace-root`
```

Web omits by **capability**, never by `isElectron()`: no `window.workspace` ⇒ no drop zone, no File-menu subscriptions, no Open-in-Terminal item; no `window.platform` ⇒ no Reveal; an FSA root's `path: null` ⇒ Copy path hidden by data.

**Tech Stack:** TypeScript strict (no `any`), React 19 + Vite, Tailwind CSS v4, Radix ContextMenu via `@brainstrike/ui`, Electron 43 main/preload/renderer bridges (`webUtils.getPathForFile`), zustand, Vitest (unit + `*.integration.test.*`), Playwright desktop E2E, Chrome DevTools MCP for live verification, Biome/Ultracite.

**Linear:** epic [BST-1387](https://linear.app/brainstrike/issue/BST-1387) → **BST-1393** "W6: Low-friction connection — root context menu, File ▸ Open Folder / Open Recent, drag-drop folders, argv/open-file" (CONFIRMED in Linear). The ticket id appears in commit prefixes AND in shipped source/doc strings — all sites use BST-1393. **Spec:** `docs/superpowers/specs/2026-08-21-workspace-checkout-awareness-design.md` §4.1, §7, §12, §13, §14, §15 (W6 row), rulings **[D7]**, **[D9]**, **[D10]**. **Depends on:** W1 (BST-1388/BST-1395/BST-1396), W3 (BST-1390), W5 (BST-1392) and **BST-1457** (the terminal-target seam) — all landed on `integration/workspace-checkout-awareness`.

> **Branch point (read before you start, and before you review):** **W6 branches from `integration/workspace-checkout-awareness` at or after `e51e4dda5`.** That tip is where `packages/app-shell/src/stores/terminal-target-store.ts`, `packages/app-shell/src/hooks/use-workspace-bar-terminal.ts` and the BST-1457 paragraph in `docs/agents/workspace-context.md` ("The Terminal's cwd is FOCUSED-by-default, PINNED-when-asked…") all exist. A checkout that predates it will read Layer 1's terminal references as phantoms — they are not. Verify before starting:
>
> ```bash
> git merge-base --is-ancestor e51e4dda5 HEAD && echo "OK: post-BST-1457" || echo "STOP: rebase onto integration first"
> ```

---

## Global Constraints

Every task's requirements implicitly include this section.

- **NO SILENT FALLBACKS, and NO NEW GRANT DOOR.** `docs/agents/workspace-context.md` calls `fs:addRootByPath`'s two authorizations "the second and last sanctioned picker-less mount". W6 adds a **third entry point class, not a third authorization**: argv, `open-file`, `second-instance`, drag-drop and the File menu's Open Recent all call the SAME `addRootDirectoryByPath`, and a never-granted path comes back as the existing `AccessError` (`'Folder was never granted in this app; use Add Folder to grant it.'`). That refusal is rendered as a destructive, **persistent** toast that names the folder and carries an **"Add folder…"** `ToastAction` opening the real OS picker. Never a quiet no-op, never a silent grant, never an invented `recordRecentRoot` call on an attacker-influencable path (another application can trigger `open-file`/argv; mounting a root hands the agent read access to that folder, so an unrecognised path gets consent, not a mount).
- **Files lists are FLOORS; the compiler is the census.** Every task that widens a type (`ContextTarget`, `WorkspaceBarProps`, `RootSectionHeaderProps`, `FileExplorerPanelProps`, the preload bridge sets) breaks type-check at sites this plan did not enumerate. After each such edit run `pnpm run type-check` FIRST and fix every site it names before running any test. Where a *fixture* rather than the compiler is the census (an object literal in a test that duck-types a bridge), the task names the `rg` command that enumerates it.
- **Capability gating by omission, never `isElectron()`.** Every new affordance takes an optional handler/prop and renders only when it exists; app-shell supplies it only behind a resolved bridge. Web renders no stub, no disabled row.
- **Actions hide, they do not disable** (`docs/agents/ui-conventions.md` CONTEXT ACTION SYSTEM): a missing capability or a `null` path removes the item. The one sanctioned `isEnabled` use is transient state, and W6 has none.
- **Targets are immutable invocation snapshots**, claimed synchronously in the `contextmenu` event, reset by `onContextMenuCapture` on the surface container. A durable RootId is identity, commonly a UUID, and is never treated as a path.
- **Falsifying wiring tests.** Every "surface A calls seam B" test uses a DISTINCT `vi.fn()` per action, asserts `toHaveBeenCalledExactlyOnceWith(...)` with exact arguments, AND asserts the sibling mocks were `not.toHaveBeenCalled()`.
- **TypeScript strict, no `any`.** `exactOptionalPropertyTypes: true` is ON (`packages/config/tsconfig/base.json:22`) — supply an optional property with a conditional spread (`...(path === null ? {} : { path })`), never `path: undefined`, unless the interface declares the key as required-with-`undefined` (the `WorkspaceBarMode` idiom). `unknown` + narrowing at every IPC boundary. Kebab-case filenames; `use-*.ts` hooks exporting camelCase; components export PascalCase; object/JSX props sorted alphabetically; union members' fields sorted alphabetically (the existing `changed-file` / `worktree` members are).
- **Biome ceilings — BOTH rules, pre-authorized remedy.** `noExcessiveLinesPerFile` `maxLines: 1000` at **error** (`biome.json:39-44`), and it counts **CODE** lines, not physical lines (verified empirically during BST-1457 planning). `noExcessiveCognitiveComplexity` `maxAllowedComplexity: 20` at **error** (`node_modules/ultracite/config/biome/core/biome.jsonc:161-166`), **per function**, and it counts the conditionals at a CALL SITE, so adding one gated wiring block to a hook that is already near the ceiling fires it. Both are `off` for `**/e2e/**`, `**/scripts/**` and the test override group, and `noExcessiveLinesPerFile` is `off` for the explicit allowlist at `biome.json:415-536` — which **includes** `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`, `packages/file-explorer-ui/src/shell/file-explorer-panel.tsx` and `packages/app-shell/src/threads-panel.tsx`, and **excludes** `packages/file-explorer-ui/src/shell/file-explorer-sidebar.tsx` (981 physical lines — the tightest source file W6 touches; only its TEST is allowlisted). **Pre-authorized remedy, applying to EITHER rule:** if `pnpm exec biome check <file>` fires `noExcessiveLinesPerFile` OR `noExcessiveCognitiveComplexity` after an edit, extract the new wiring into the sibling module the task names (Task 3 names `use-root-section-context-menu.ts`; Task 6 names `use-connect-folder.ts`; Task 12 names `workspace-bar-drop-zone.tsx`) rather than shrinking the change. Do not add a path to the `biome.json` allowlist.
- **Testing lanes:** Vitest unit for pure logic, hooks and components; `*.integration.test.ts` only where a real backend is involved (W6 has none); Playwright desktop E2E. `e2e/add-root-ui.smoke.desktop.test.ts` and `e2e/workspace-bar.desktop.test.ts` are ALREADY registered in `apps/desktop/package.json`'s `test:e2e:lane:smoke` list — **W6 adds no new e2e FILE and needs no lane registration.** **Live CDT verification is part of the definition of done** — report COMPUTED VALUES (menu item labels/`disabled`/`aria-*`, rects, the drop zone's computed ring), never impressions.
- **Gates before each PR:** touched packages' `test`, root `pnpm run type-check`, `pnpm run lint:eslint`, `pnpm dlx ultracite fix <files>`, `npx react-doctor . --scope changed --base <previous-task-sha> --verbose -y` (no NEW error-severity findings in touched files — the bare `pnpm run react-doctor` script pins `--scope full`, which is repo-wide and always non-zero on pre-existing baseline debt; use the scoped form). Pristine output — no `act()` warnings, no unasserted logger lines.
- **Docs in-band**, in the same PR as the code: `docs/agents/workspace-context.md` (replace the DEFERRED root-header paragraph; document the four entry points and the refusal contract) and `docs/agents/ui-conventions.md` (the new target kind + its surface).
- **Stack:** one branch per layer on trunk `integration/workspace-checkout-awareness`, created with `gh stack add`. NEVER target `main`. Land bottom-up. Commit messages `feat|fix|test|docs(BST-1393): …` with trailer:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```
- `@mastra/core` stays Node-only/externalized; local inference stays renderer-only. Nothing here touches either.

---

## Scope boundaries (read before starting)

**In scope (W6):** the `workspace-root` ContextTarget kind, its adapter, its two global actions and its four surface-local actions; the Explorer root-header context menu; the `window.workspace` bridge; the renderer connect-folder seam and its refusal contract; the desktop File menu (Open Folder… ⌘O, Open Recent, Clear Menu) and `app.addRecentDocument`; argv / `second-instance` argv / macOS `open-file`; folder drag-drop onto the composer's workspace bar; desktop E2E; a CDT verification pass; the two living-doc updates.

**Explicitly OUT of scope (owner named):**
- **A drop zone on the Explorer sidebar.** Spec §4.1's literal wording is "Drag a folder from Finder onto the **composer**". Task 12 ships the composer surface and factors the extraction + mount logic so the Explorer surface is `<WorkspaceBarDropZone>`-shaped reuse; the second surface is a named follow-up (ruling **L4** below), not a silent omission.
- **`defaultPath`-seeded pickers.** The refusal remedy opens the ordinary `addRootDirectory()` picker rather than one pre-navigated to the refused path. Seeding would widen `FileSystemAdapter.requestDirectoryAccess()` across `packages/types`, `packages/file-system` (electron AND web adapters), `packages/file-explorer-hooks`, the preload and `apps/desktop/src/renderer/adapters.ts` for one caller. Ruling **S3**; follow-up named.
- **Recording a grant from argv / `open-file` / a drop.** Ruling **S1**. Would be a third picker-less door on an attacker-influencable path.
- **"Remove from recents" (§7 [D9]'s second half).** Still deferred by W1 (`docs/superpowers/plans/2026-08-21-w1-workspace-bar-foundation.md:25`) — it needs a main-side ledger mutation plus its own factory-reset and corruption story. W6 does not touch it. What W6 DOES ship from [D9] is the "Folder not found" half: a recents entry whose path is gone refuses visibly through the same toast (`createSecureRoot` throws), which is the honest half that needs no new mutation.
- **`brainstrike://` URL scheme / `open-url` / `setAsDefaultProtocolClient`.** Not in §7; a protocol handler is a materially larger security surface than a folder path.
- **Windows jump-list / macOS Dock menu customization** beyond what `app.addRecentDocument` gives for free.
- **The workspace bar's own per-thread "Make primary".** Untouched — see ruling **R1**: the root header's action is the WORKSPACE **Main** root, a different thing with a different writer.

**Sibling-PR collisions to watch:** `packages/app-shell/src/hooks/use-workspace-bar.ts`, `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx`, `packages/file-explorer-ui/src/shell/file-explorer-sidebar.tsx`, `apps/desktop/src/main.ts` and `apps/desktop/src/preload.ts` are hot files across this epic. Re-read each at HEAD before applying a diff; do not apply blind. This plan adds NO migration and NO table, so the migration space is collision-free.

---

## Resolved spec ambiguities (read before Task 1)

| # | Ambiguity | Resolution used by this plan |
| --- | --- | --- |
| **R1** | §7 lists the root menu's first item as **"Make primary"**, but the deferred ruling this closes (`workspace-context.md`, DEFERRED bullet) calls it **"Set as main"**. The workspace bar already ships a *thread-scoped* "Make primary" that writes the `operatingRoot*` metadata triple and deliberately NEVER calls `setMainRoot`. | **The root header's item is "Set as main" — the workspace-wide MAIN root (`activeRootIds[0]`, `setMainRoot`).** Three reasons: (1) the header is the surface that already RENDERS the `Main` badge (`root-section-header.tsx`, `data-testid="root-main-badge"`), so a "Make primary" there would name a role the row does not display; (2) `workspace-root-status-item.tsx` already pairs that same badge with an `onSetMainRoot={setMainRoot}` row — W6 reuses that vocabulary rather than inventing a third one; (3) the thread-scoped primary needs a selected thread and a metadata write queue, neither of which a workspace-tree surface has. The item is HIDDEN (not disabled) when `target.isMain` is already true. Spec §7's "Make primary" and the ruling's "Set as main" are the same intent; the ruling's wording wins because it names the mechanism that exists. |
| **R2** | Which surface owns the `workspace-root` target — the Explorer root headers, the Folder chip's root rows, or both? | **The Explorer root headers only.** That is verbatim what the deferred ruling defers ("a root-header right-click context action … root headers have no ContextTarget kind yet"). The Folder chip's rows already carry the same six affordances as explicit menu items with per-thread semantics (`folder-chip.tsx`: Make primary / Remove from thread / Reveal / Copy path / Open in Terminal), and giving them a SECOND, workspace-scoped menu with a same-named-but-different-meaning "primary" is precisely the confusion R1 avoids. One kind, one surface. |
| **S1** | argv / `open-file` / a Finder drop hand the app a path that may never have been granted. Grant it, or refuse it? | **Refuse it, visibly, with a one-click remedy.** `open-file` and argv are *attacker-influencable* — any other application on the machine can run `open -a BrainStrike <path>` or hand the app an `open-file` event, and a mounted root is read access for the agent (and for `readWorkspaceContext`). A drop is user-driven but *renderer-claimed*. Recording `recordRecentRoot` on any of them would be a third picker-less door on exactly the input class that most needs consent. So all four entry points call `addRootDirectoryByPath` and let main's existing two gates decide; the refusal renders as a persistent destructive toast naming the folder plus an **"Add folder…"** `ToastAction`. **This is not the friction it looks like:** the ledger holds up to `RECENT_ROOTS_LIMIT = 50` previously granted folders and a disconnect does NOT revoke the grant, so `brainstrike .` in any repo you have ever opened just works. Only a genuinely new folder costs one picker confirmation. |
| **S2** | `fs:addRootByPath` throws for THREE distinguishable reasons — never granted, managed-but-unauthorized, and "the path is not there / not readable" (`createSecureRoot` rejects). Should the renderer branch on them? | **Yes, on exactly one boundary: granted-vs-not.** The renderer matches the two literal never-granted messages (duplicated as constants with the same "errors cross IPC as plain strings" comment `worktree-map-surface.tsx:46` already carries) to choose the *remedy* copy — "Add folder…" for a grant problem, plain error text otherwise (which is [D9]'s "Folder not found" case). A message that matches neither degrades to the raw error, never to a wrong remedy. No `instanceof AccessError` across IPC: the class does not survive structured cloning. |
| **B1** | Where does the new main→renderer surface live: extend `window.platform`, extend `window.electronAPI.fileSystem`, or a new bridge? | **A new `window.workspace` bridge.** `window.platform`'s key set is pinned EXACTLY (`PLATFORM_BRIDGE_REQUIRED_METHODS`) and — the deciding fact — `packages/app-shell/src/__tests__/context-action-registry.test.ts` duck-types that bridge in FOUR object literals; adding a fourth required member would make every one of them "malformed" and silently flip `fs.reveal` off in tests the compiler cannot flag. `electronAPI.fileSystem` is an INVOKE surface with no `on*` members. A new three-member bridge (`getDroppedPath`, `onOpenFolderPicker`, `onOpenPath`) costs one `*_BRIDGE_REQUIRED_METHODS` constant and one entry in the preload contract test's `expectedBridgeMethods` map, and disturbs nothing. |
| **B2** | `webUtils.getPathForFile` is not IPC — should it really sit on a bridge whose other two members are event subscriptions? | **Yes.** `window.workspace` is "desktop workspace-CONNECTION integration", and all three members exist for exactly one job: turning an OS-level gesture into a folder path this app can ask to mount. Splitting a one-function bridge out would double the contract-test surface for no separation. The preload wrapper catches `getPathForFile`'s documented throw (it throws when the argument is not a `File`) and returns `''`; `''` is a REPORTED outcome the extractor counts and the UI states, not a silent degradation. |
| **M1** | The application menu template is a ~160-line array built inline inside `app.whenReady()` in `main.ts`, closing over `logger`, `noteNextWindowReload`, `resetDesktopDatabaseProfile`, `dialog` and a module-level in-flight flag. Extract the whole thing? | **No — extract only the File submenu.** A new pure `apps/desktop/src/application-file-menu.ts` exports `buildFileMenuTemplate(deps)` returning ONE `MenuItemConstructorOptions`, inserted at index 1 of the existing array. That is the unit under test (labels, accelerators, ids, click routing, the Open Recent projection) and it needs none of the closure. Extracting the other three submenus is a real refactor of a hot file for zero W6 coverage. |
| **M2** | Open Recent must reflect the ledger, but the menu is built once inside `whenReady`. | **Rebuild the application menu when main records a grant.** `registerFileSystemIpcHandlers` gains an optional `onWorkspaceRootGranted?: (grantedPath: string) => void`, fired after a successful `fs:addRoot` / `fs:addRootByPath`. main's handler does two things: `app.addRecentDocument(grantedPath)` (spec §7's explicit ask — it feeds the macOS Dock menu and the Windows jump list, whose clicks arrive as `open-file`/argv, i.e. Layer 3's entry point) and a coalesced `rebuildApplicationMenu()`. Boot-time recents need no trigger: the menu is built after `registerIpcHandlers`, so the first read already sees the restored ledger. |
| **M3** | Should "Open Folder…" call `dialog.showOpenDialog` in main directly? | **No — it pushes `workspace:open-folder-picker` to the focused window and the renderer calls the SAME `addRootDirectory()` the Folder chip's "Add folder…" calls.** One flow means one grant recording, one reconciliation nudge, one error surface. A main-side dialog would bypass `useFileSystem`'s mount bookkeeping entirely. This mirrors the Cmd+K/Cmd+P precedent exactly (`main.ts:1926` → `preload.ts` `COMMAND_PALETTE_OPEN_EVENT` → `command-palette-host.tsx`). |
| **L3** | `second-instance` argv is listed in the ticket, but `main.ts` registers that listener only `if (!e2eTestMode)`. | **Ship it, and say plainly that it is not e2e-testable.** The handler moves from a no-arg closure to `(_event, argv, workingDirectory) => …`, parses folders with the SAME pure helper argv uses, enqueues them, and then does exactly what it does today (show + focus the first non-host window). Coverage: the pure parser is unit-tested and the enqueue→deliver path is proven end-to-end by the `open-file` e2e (same queue, same channel). No invented e2e. |
| **L4** | The composer bar and the Explorer sidebar are both plausible drop zones. | **Composer only in W6** (spec §4.1's literal wording). Task 12 puts the ring + `Files`-gate in a reusable `WorkspaceBarDropZone` and the path extraction in a pure module, so the Explorer surface is a props-only addition later. Named as a follow-up, not omitted in silence. |
| **D1** | A dropped item's `File` cannot be told apart from a folder's `File` by size or type. Guess in the renderer, or let main decide? | **Neither guess nor blind-send: ask the DOM.** `DataTransferItem.webkitGetAsEntry()` is synchronous and reports `isDirectory` exactly; the same item's `getAsFile()` yields the `File` whose path `getDroppedPath` resolves — no index-pairing between `items` and `files`. Everything happens inside the drop tick (the Notes Vault `drop.ts` contract, whose own test invalidates the item after one microtask to prove it). Non-directory items are counted and reported in the notice, never sent to `addRootDirectoryByPath` to fail with a grant message that would misdescribe the problem. |

---

## Dependency DAG (execution order and what may run in parallel)

```
       ┌────────────────────────────────────────────────────────────┐
       │ L1  workspace-root ContextTarget      (Tasks 1–4)          │  ← independent
       │ kind → global actions → header surface → app-shell inject  │
       └────────────────────────────────────────────────────────────┘

       ┌────────────────────────────────────────────────────────────┐
       │ L2  the connect-folder seam + bridge   (Tasks 5–7)         │  ← independent of L1
       │ window.workspace → renderer host+toast → File menu/main    │
       └───────────────────────────┬────────────────────────────────┘
                                   │
            ┌──────────────────────┴───────────────────────┐
            ▼                                              ▼
  ┌──────────────────────────────┐        ┌──────────────────────────────┐
  │ L3  argv / open-file         │        │ L4  drag-drop folders        │
  │     (Tasks 8–10)             │        │     (Tasks 11–12)            │
  │ apps/desktop/src/** only     │        │ app-shell + assistant-ui     │
  └──────────────┬───────────────┘        └───────────────┬──────────────┘
                 └───────────────────┬────────────────────┘
                                     ▼
       ┌────────────────────────────────────────────────────────────┐
       │ L5  verification            (Tasks 13–14)                  │
       │ desktop E2E + CDT probe + living docs                       │
       └────────────────────────────────────────────────────────────┘
```

**Parallel-execution rules for a fleet:**

- **L1 ∥ L2 are genuinely file-disjoint.** L1: `packages/context-actions/src/types.ts`, `packages/file-explorer-ui/src/context-actions/**`, `packages/file-explorer-ui/src/components/root-section-header.tsx`, `packages/file-explorer-ui/src/shell/file-explorer-sidebar.tsx`, `packages/file-explorer-ui/src/shell/file-explorer-panel.tsx`, `packages/app-shell/src/context-action-registry.ts`, `packages/app-shell/src/workspace-root-context-actions.tsx`, `packages/app-shell/src/explorer-search-tabs.tsx`. L2: `apps/desktop/src/{platform/desktop-ipc-channels,preload,main,application-file-menu,types/electron.d}.ts`, `apps/desktop/src/ipc-domains/file-system-ipc.ts`, `packages/app-shell/src/workspace-connect/**`, `apps/desktop/src/renderer/components/root-layout-content.tsx`. **The only shared file is `packages/app-shell/src/__tests__/…` fixtures** — no source overlap.
- **L1's four tasks are strictly sequential**; so are L2's three.
- **L3 ∥ L4 after L2.** L3 is `apps/desktop/src/**` only. L4 is `packages/app-shell/src/workspace-connect/**` + `packages/assistant-ui/src/workspace-bar/**` + the preload's `getDroppedPath` member (already landed by Task 5 — L4 only CONSUMES it).
- **L5 is strictly after every other layer.**
- **Landing order is linear** (`gh stack`): L1 → L2 → L3 → L4 → L5.

---

# Layer 1 — the `workspace-root` ContextTarget

## Task 1: the target kind + its adapter

**Files (FLOOR — the compiler is the census for the union widening):** `packages/context-actions/src/types.ts`, `packages/file-explorer-ui/src/context-actions/workspace-root-target.ts` (new), `packages/file-explorer-ui/src/context-actions/index.ts`, `packages/file-explorer-ui/src/context-actions/__tests__/workspace-root-target.test.ts` (new)

**Census command — run BEFORE writing code and again after Step 2:**

```bash
pnpm run type-check
rg -n "ContextTargetKind|appliesTo:" --glob '!**/dist/**' packages apps | rg -v '__tests__'
```

Adding a union MEMBER (rather than a field to an existing one) cannot break an exhaustive `switch` that has a `default`, but it DOES widen `ContextTargetKind`, so any `Record<ContextTargetKind, …>` map becomes incomplete. At the integration tip there is no such map — `bridge-action-to-command.ts:57` casts, `registry.ts` filters — but the type-check is what proves that, not this sentence.

- [ ] **Step 1 (RED): pin the adapter contract**

Create `packages/file-explorer-ui/src/context-actions/__tests__/workspace-root-target.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { workspaceRootToTarget } from '../workspace-root-target';

describe('workspaceRootToTarget', () => {
  it('snapshots a desktop root with its absolute path and Main role', () => {
    expect(
      workspaceRootToTarget({
        displayName: 'brainstrike',
        isMain: true,
        path: '/Users/dev/GitHub/brainstrike',
        rootId: '0199a1f0-6c3e-7a11-9b2d-2b7f1f4a55aa',
      })
    ).toEqual({
      displayName: 'brainstrike',
      isMain: true,
      kind: 'workspace-root',
      path: '/Users/dev/GitHub/brainstrike',
      rootId: '0199a1f0-6c3e-7a11-9b2d-2b7f1f4a55aa',
    });
  });

  it('reports path: null when the root has no path distinct from its name (web FSA)', () => {
    // [CORRECTED post-Task-1 review, folded into Task 2: this is NOT a rule
    // `RootSectionHeader` already applies — that component's own `path` prop
    // is a plain truthiness check and its doc says callers omit it for FSA
    // roots. The comparison is NEW logic in `workspaceRootToTarget`.]
    // A web FSA `DirectoryHandle.path` IS its `name`; passing that through
    // as a "path" would make Copy Path copy a folder NAME on web.
    expect(
      workspaceRootToTarget({
        displayName: 'notes',
        isMain: false,
        path: 'notes',
        rootId: 'root-web-1',
      }).path
    ).toBeNull();
  });

  it('reports path: null for an absent path', () => {
    expect(
      workspaceRootToTarget({ displayName: 'notes', isMain: false, rootId: 'root-web-1' }).path
    ).toBeNull();
  });

  it('never treats the durable root id as a path', () => {
    // Regression guard for the ui-conventions rule: a RootId is commonly a
    // UUID. If a future edit derived `path` from `rootId`, this catches it.
    const target = workspaceRootToTarget({
      displayName: 'brainstrike',
      isMain: false,
      rootId: '0199a1f0-6c3e-7a11-9b2d-2b7f1f4a55aa',
    });
    expect(target.path).toBeNull();
    expect(target.rootId).toBe('0199a1f0-6c3e-7a11-9b2d-2b7f1f4a55aa');
  });
});
```

Run it and see it fail (the module does not exist):

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/context-actions/__tests__/workspace-root-target.test.ts
```

- [ ] **Step 2 (GREEN): add the union member**

Append to the `ContextTarget` union in `packages/context-actions/src/types.ts`, AFTER the `worktree` member (last in the union today) and before the closing `;`:

```ts
  /**
   * A CONNECTED workspace root — the Explorer's per-root section header
   * (spec §7). This kind closes the `docs/agents/workspace-context.md`
   * DEFERRED ruling ("root headers have no ContextTarget kind yet").
   *
   * `rootId` is the surface's resolved root IDENTITY: the durable `roots.id`
   * when one exists, otherwise the legacy path-as-id the forest already falls
   * back to (`RootSection`'s `rootIdentity`). Like every other durable root id
   * in this union it is commonly a UUID and MUST NOT be treated as a path.
   *
   * `path` is `null` when the root has no absolute path distinct from its
   * name — a browser File-System-Access root, whose `DirectoryHandle.path` IS
   * its `name` (`packages/types/src/file-system.ts`: "on web `path` is only
   * the directory name"). [CORRECTED post-Task-1 review, folded into Task 2:
   * this name-equality check is NEW normalization logic in
   * `workspaceRootToTarget`, not a rule reused from `RootSectionHeader` —
   * that component's own `path` prop is a plain truthiness check
   * (`{path ? ... : name}`) and its doc says callers must omit the prop for
   * FSA roots; nothing in the header itself compares `path` against a
   * display name.] Path-shaped actions gate on the DATA (`isVisible`) and
   * web hides them without any platform check.
   *
   * `isMain` is the workspace-wide MAIN role (`activeRootIds[0]`) the header
   * renders as its "Main" badge — deliberately NOT the workspace bar's
   * per-thread primary, which has a different writer and a different meaning
   * (BST-1393 ruling R1).
   */
  | {
      readonly displayName: string;
      readonly isMain: boolean;
      readonly kind: 'workspace-root';
      readonly path: string | null;
      readonly rootId: string;
    };
```

Create `packages/file-explorer-ui/src/context-actions/workspace-root-target.ts`:

```ts
import type { TargetOf } from '@brainstrike/context-actions';

export interface WorkspaceRootTargetInput {
  readonly displayName: string;
  readonly isMain: boolean;
  /**
   * The root handle's `path`. On desktop this is the absolute filesystem
   * path; on web an FSA handle reports its NAME here, which is not a path at
   * all — see the normalization below.
   */
  readonly path?: string | undefined;
  readonly rootId: string;
}

/**
 * Root section header → immutable invocation snapshot, claimed synchronously
 * in the `contextmenu` event (ui-conventions: targets are snapshots, never
 * live store lookups).
 *
 * The ONE normalization: a `path` equal to the display name is reported as
 * `null`. [CORRECTED post-Task-1 review, folded into Task 2: this is NEW
 * logic, not a rule reused from `RootSectionHeader` — that component's own
 * `path` prop is a plain truthiness check (`{path ? ... : name}`) and its
 * doc says callers must omit the prop for FSA roots; nothing in the header
 * itself compares `path` against a display name.] The comparison lives here
 * because a web FSA root's `DirectoryHandle.path` reports its NAME
 * (`packages/types/src/file-system.ts`: "on web `path` is only the
 * directory name" — there is no absolute filesystem path to give). Without
 * this normalization, "Copy Path" on web would copy a bare folder name and
 * "Reveal" would hand the shell a non-path.
 */
export function workspaceRootToTarget({
  displayName,
  isMain,
  path,
  rootId,
}: WorkspaceRootTargetInput): TargetOf<'workspace-root'> {
  return {
    displayName,
    isMain,
    kind: 'workspace-root',
    path: path && path !== displayName ? path : null,
    rootId,
  };
}
```

Add to `packages/file-explorer-ui/src/context-actions/index.ts` (alphabetical among the existing export blocks — after the `file-surface-target` block):

```ts
export {
  type WorkspaceRootTargetInput,
  workspaceRootToTarget,
} from './workspace-root-target';
```

- [ ] **Step 3 (VERIFY)**

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/context-actions/__tests__/workspace-root-target.test.ts
pnpm --filter @brainstrike/context-actions test
pnpm run type-check
pnpm dlx ultracite fix packages/context-actions/src/types.ts packages/file-explorer-ui/src/context-actions/workspace-root-target.ts packages/file-explorer-ui/src/context-actions/index.ts packages/file-explorer-ui/src/context-actions/__tests__/workspace-root-target.test.ts
```

- [ ] **Step 4: commit**

```bash
git add -A && git commit -m "feat(BST-1393): add the workspace-root ContextTarget kind and its adapter

Closes the workspace-context.md deferral that root headers have no
ContextTarget kind. The adapter normalizes a web FSA handle's name-as-path
to null so path-shaped actions hide by data rather than by platform.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: the two GLOBAL workspace-root actions (Copy path, Reveal)

**Files:** `packages/file-explorer-ui/src/context-actions/workspace-root-actions.ts` (new), `packages/file-explorer-ui/src/context-actions/index.ts`, `packages/app-shell/src/context-action-registry.ts`, `packages/file-explorer-ui/src/context-actions/__tests__/workspace-root-actions.test.ts` (new), `packages/app-shell/src/__tests__/context-action-registry.test.ts`

**Why these two are GLOBAL and the other four are LOCAL:** these close over nothing but `ActionServices` (the same clipboard/platformFs the file actions use), so they belong in the registry where the ⌘K command projection can also reach them. Set as main / Disconnect / Open in Terminal / New thread here all close over a store or a bridge, which `ui-conventions.md` routes through `localActions`.

- [ ] **Step 1 (RED): pin both actions**

Create `packages/file-explorer-ui/src/context-actions/__tests__/workspace-root-actions.test.ts` (modelled on the sibling `file-entry-actions.test.ts`):

```ts
import type { ActionServices, ContextTarget } from '@brainstrike/context-actions';
import { describe, expect, it, vi } from 'vitest';
import {
  copyWorkspaceRootPathAction,
  revealWorkspaceRootAction,
  workspaceRootActions,
} from '../workspace-root-actions';

const desktopRoot: ContextTarget = {
  displayName: 'brainstrike',
  isMain: true,
  kind: 'workspace-root',
  path: '/Users/dev/GitHub/brainstrike',
  rootId: '0199a1f0-6c3e-7a11-9b2d-2b7f1f4a55aa',
};

const webRoot: ContextTarget = {
  displayName: 'notes',
  isMain: false,
  kind: 'workspace-root',
  path: null,
  rootId: 'root-web-1',
};

function makeServices() {
  return {
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    platformFs: {
      openPath: vi.fn().mockResolvedValue({ ok: true }),
      showItemInFolder: vi.fn().mockResolvedValue({ ok: true }),
    },
  } satisfies ActionServices;
}

describe('workspaceRootActions', () => {
  it('exports exactly the two capability-gated global root actions', () => {
    expect(workspaceRootActions.map((action) => action.id)).toEqual([
      'workspace-root.copy-path',
      'workspace-root.reveal',
    ]);
    for (const action of workspaceRootActions) {
      expect(action.appliesTo).toEqual(['workspace-root']);
    }
  });

  it('copies the root path', async () => {
    const services = makeServices();
    const outcome = await copyWorkspaceRootPathAction.run(desktopRoot, services);
    expect(services.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(
      '/Users/dev/GitHub/brainstrike'
    );
    expect(outcome).toEqual({ message: 'Folder path copied', ok: true });
  });

  it('reveals the root in the OS file manager', async () => {
    const services = makeServices();
    const outcome = await revealWorkspaceRootAction.run(desktopRoot, services);
    expect(services.platformFs.showItemInFolder).toHaveBeenCalledExactlyOnceWith(
      '/Users/dev/GitHub/brainstrike'
    );
    expect(services.platformFs.openPath).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: true });
  });

  it('HIDES both actions for a pathless root instead of failing at click time', () => {
    // The falsifier for a `isEnabled`-instead-of-`isVisible` implementation:
    // a disabled row would still render on web, which ui-conventions forbids.
    expect(copyWorkspaceRootPathAction.isVisible?.(webRoot)).toBe(false);
    expect(revealWorkspaceRootAction.isVisible?.(webRoot)).toBe(false);
    expect(copyWorkspaceRootPathAction.isVisible?.(desktopRoot)).toBe(true);
    expect(revealWorkspaceRootAction.isVisible?.(desktopRoot)).toBe(true);
    expect(copyWorkspaceRootPathAction.isEnabled).toBeUndefined();
    expect(revealWorkspaceRootAction.isEnabled).toBeUndefined();
  });

  it('declares the capabilities that gate them off web', () => {
    expect(copyWorkspaceRootPathAction.requiredCapabilities).toEqual(['clipboard']);
    expect(revealWorkspaceRootAction.requiredCapabilities).toEqual(['fs.reveal']);
  });

  it('refuses rather than throwing if run is reached with no path', async () => {
    const services = makeServices();
    await expect(copyWorkspaceRootPathAction.run(webRoot, services)).resolves.toEqual({
      error: 'This folder has no filesystem path.',
      ok: false,
    });
    await expect(revealWorkspaceRootAction.run(webRoot, services)).resolves.toEqual({
      error: 'This folder has no filesystem path.',
      ok: false,
    });
    expect(services.clipboard.writeText).not.toHaveBeenCalled();
    expect(services.platformFs.showItemInFolder).not.toHaveBeenCalled();
  });

  it('labels Reveal with the platform file-manager name, never a hardcoded OS', () => {
    const label = revealWorkspaceRootAction.label;
    if (typeof label !== 'function') {
      throw new Error('Reveal must derive its label from the platform');
    }
    expect(label(desktopRoot)).toMatch(/^Reveal in (Finder|File Explorer)$/);
  });
});
```

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/context-actions/__tests__/workspace-root-actions.test.ts
```

- [ ] **Step 2 (GREEN): the actions**

Create `packages/file-explorer-ui/src/context-actions/workspace-root-actions.ts`:

```ts
import {
  type AnyContextAction,
  type ContextAction,
  defineContextAction,
} from '@brainstrike/context-actions';
import { Copy, FolderOpen } from 'lucide-react';
import { revealLabel } from './file-entry-actions';

/**
 * The two `workspace-root` actions that close over NOTHING but
 * `ActionServices`, which is what makes them global-registry members rather
 * than surface-local ones (`ui-conventions.md`: surface-local actions are the
 * ones that close over surface stores). Set as main, Disconnect, Open in
 * Terminal and New thread here all close over a store or a bridge and travel
 * through `localActions` instead — see `workspace-root-local-actions.ts` and
 * `packages/app-shell/src/workspace-root-context-actions.tsx`.
 *
 * Both HIDE for a pathless root (`isVisible`), never disable: a web FSA root
 * genuinely has no path, and ui-conventions rules data-shaped gating hidden.
 */
const NO_PATH = 'This folder has no filesystem path.';

const copyWorkspaceRootPath: ContextAction<'workspace-root'> = {
  appliesTo: ['workspace-root'],
  group: 'copy',
  icon: Copy,
  id: 'workspace-root.copy-path',
  isVisible: (target) => target.path !== null,
  label: 'Copy Path',
  requiredCapabilities: ['clipboard'],
  run: async (target, services) => {
    if (target.path === null) {
      return { error: NO_PATH, ok: false };
    }
    if (!services.clipboard) {
      return { error: 'Clipboard service unavailable', ok: false };
    }
    const outcome = await services.clipboard.writeText(target.path);
    return outcome.ok ? { message: 'Folder path copied', ok: true } : outcome;
  },
};

const revealWorkspaceRoot: ContextAction<'workspace-root'> = {
  appliesTo: ['workspace-root'],
  group: 'navigate',
  icon: FolderOpen,
  id: 'workspace-root.reveal',
  isVisible: (target) => target.path !== null,
  // Never a hardcoded OS name — same helper the workspace bar's reveal uses.
  label: () => revealLabel(),
  requiredCapabilities: ['fs.reveal'],
  run: async (target, services) => {
    if (target.path === null) {
      return { error: NO_PATH, ok: false };
    }
    if (!services.platformFs) {
      return { error: 'Platform file-system service unavailable', ok: false };
    }
    return await services.platformFs.showItemInFolder(target.path);
  },
};

export const copyWorkspaceRootPathAction = defineContextAction(copyWorkspaceRootPath);
export const revealWorkspaceRootAction = defineContextAction(revealWorkspaceRoot);

export const workspaceRootActions: readonly AnyContextAction[] = [
  copyWorkspaceRootPathAction,
  revealWorkspaceRootAction,
];
```

Add to `packages/file-explorer-ui/src/context-actions/index.ts`:

```ts
export {
  copyWorkspaceRootPathAction,
  revealWorkspaceRootAction,
  workspaceRootActions,
} from './workspace-root-actions';
```

- [ ] **Step 3 (GREEN): register them**

In `packages/app-shell/src/context-action-registry.ts`, extend the import and the composed array:

```ts
import {
  fileEntryActions,
  workspaceRootActions,
} from '@brainstrike/file-explorer-ui/context-actions';
```

```ts
    actions: [
      ...fileEntryActions,
      ...workspaceRootActions,
      ...collectionActions,
      ...assistantThreadActions,
      ...changesActions,
    ],
```

- [ ] **Step 4 (RED→GREEN): pin the registry composition**

Append to the existing `describe('createAppActionRegistry', …)` in `packages/app-shell/src/__tests__/context-action-registry.test.ts`:

```ts
  it('composes the workspace-root actions, gated by the platform bridge', () => {
    const webRegistry = createAppActionRegistry();
    const webIds = webRegistry
      .actionsFor({
        displayName: 'notes',
        isMain: false,
        kind: 'workspace-root',
        path: null,
        rootId: 'root-web-1',
      })
      .flatMap((group) => group.actions.map((action) => action.id));
    // Web: no platform bridge (no Reveal) AND no path (no Copy Path). The
    // menu is empty, which ActionContextMenu renders as NO menu at all.
    expect(webIds).toEqual([]);

    (window as MutableWindow).platform = {
      openExternal: vi.fn(),
      openPath: vi.fn(),
      showItemInFolder: vi.fn(),
    };
    const desktopRegistry = createAppActionRegistry();
    const desktopIds = desktopRegistry
      .actionsFor({
        displayName: 'brainstrike',
        isMain: true,
        kind: 'workspace-root',
        path: '/Users/dev/GitHub/brainstrike',
        rootId: 'root-1',
      })
      .flatMap((group) => group.actions.map((action) => action.id));
    expect(desktopIds).toEqual(['workspace-root.copy-path', 'workspace-root.reveal']);
  });
```

- [ ] **Step 5 (VERIFY)**

```bash
pnpm --filter @brainstrike/file-explorer-ui exec vitest run src/context-actions
pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/context-action-registry.test.ts
pnpm run type-check
pnpm dlx ultracite fix packages/file-explorer-ui/src/context-actions packages/app-shell/src/context-action-registry.ts packages/app-shell/src/__tests__/context-action-registry.test.ts
npx react-doctor . --scope changed --base <task-1-sha> --verbose -y
```

- [ ] **Step 6: commit**

```bash
git add -A && git commit -m "feat(BST-1393): global Copy Path and Reveal actions for workspace roots

Both hide (never disable) for a pathless FSA root, so web omits them by
data and by capability rather than by an isElectron check.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: the Explorer root-header context menu (surface + local actions)

**Files (FLOOR):** `packages/file-explorer-ui/src/context-actions/workspace-root-local-actions.ts` (new), `packages/file-explorer-ui/src/context-actions/index.ts`, `packages/file-explorer-ui/src/components/root-section-header.tsx`, `packages/file-explorer-ui/src/shell/use-root-section-context-menu.ts` (new), `packages/file-explorer-ui/src/shell/file-explorer-sidebar.tsx`, `packages/file-explorer-ui/src/shell/file-explorer-panel.tsx`, `packages/file-explorer-ui/src/context-actions/__tests__/workspace-root-local-actions.test.ts` (new), `packages/file-explorer-ui/src/__tests__/root-section-context-menu.test.tsx` (new)

**Interfaces this task lands:**

```ts
// packages/file-explorer-ui/src/context-actions/workspace-root-local-actions.ts
export interface WorkspaceRootLocalActionDeps {
  readonly onDisconnect: (target: TargetOf<'workspace-root'>) => void;
  readonly onSetAsMain: (target: TargetOf<'workspace-root'>) => void;
}
export function buildWorkspaceRootLocalActions(
  deps: WorkspaceRootLocalActionDeps
): AnyContextAction[];

// packages/file-explorer-ui/src/components/root-section-header.tsx
export interface RootSectionHeaderProps {
  // …unchanged members
  /** Claims the `workspace-root` ContextTarget for this row. Absent ⇒ no menu. */
  onContextMenu?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
}

// packages/file-explorer-ui/src/shell/file-explorer-panel.tsx (+ sidebar, + RootSection)
export interface FileExplorerPanelProps {
  // …unchanged members
  /**
   * Host-composed `workspace-root` context actions (Open in Terminal, New
   * thread here). Injected for the same reason `selectionActions` is: they
   * close over app-shell seams this package must not depend on.
   */
  readonly rootActions?: readonly AnyContextAction[] | undefined;
}
```

> **Biome contingency (pre-authorized, BOTH rules):** `file-explorer-sidebar.tsx` is 981 physical lines and is NOT on `biome.json`'s `noExcessiveLinesPerFile` allowlist. If `pnpm exec biome check packages/file-explorer-ui/src/shell/file-explorer-sidebar.tsx` fires EITHER `noExcessiveLinesPerFile` OR `noExcessiveCognitiveComplexity` after Step 4, move the controller + claim + local-action memo out of `RootSection` into `packages/file-explorer-ui/src/shell/use-root-section-context-menu.ts` (already in the Files list for exactly this reason) and have `RootSection` consume the returned `{ claim, controller, localActions, reset }` object. Do not shrink the feature and do not add the file to the allowlist.

- [ ] **Step 1 (RED): pin the local actions**

Create `packages/file-explorer-ui/src/context-actions/__tests__/workspace-root-local-actions.test.ts`:

```ts
import type { ContextTarget, TargetOf } from '@brainstrike/context-actions';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkspaceRootLocalActions } from '../workspace-root-local-actions';

const mainRoot: TargetOf<'workspace-root'> = {
  displayName: 'brainstrike',
  isMain: true,
  kind: 'workspace-root',
  path: '/Users/dev/GitHub/brainstrike',
  rootId: 'root-1',
};
const secondaryRoot: TargetOf<'workspace-root'> = { ...mainRoot, isMain: false, rootId: 'root-2' };

const NO_SERVICES = {} as const;

function makeDeps() {
  return { onDisconnect: vi.fn(), onSetAsMain: vi.fn() };
}

describe('buildWorkspaceRootLocalActions', () => {
  it('exports Set as main and Disconnect, in that order', () => {
    expect(buildWorkspaceRootLocalActions(makeDeps()).map((action) => action.id)).toEqual([
      'workspace-root.set-as-main',
      'workspace-root.disconnect',
    ]);
  });

  it('HIDES Set as main for the root that is already Main', () => {
    const [setAsMain] = buildWorkspaceRootLocalActions(makeDeps());
    expect(setAsMain?.isVisible?.(mainRoot as ContextTarget)).toBe(false);
    expect(setAsMain?.isVisible?.(secondaryRoot as ContextTarget)).toBe(true);
  });

  it('routes Set as main to its own dep and nothing else', async () => {
    const deps = makeDeps();
    const [setAsMain] = buildWorkspaceRootLocalActions(deps);
    await expect(setAsMain?.run(secondaryRoot as ContextTarget, NO_SERVICES)).resolves.toEqual({
      ok: true,
    });
    expect(deps.onSetAsMain).toHaveBeenCalledExactlyOnceWith(secondaryRoot);
    expect(deps.onDisconnect).not.toHaveBeenCalled();
  });

  it('STAGES Disconnect — the run opens the confirmation, it never removes a root', async () => {
    // ui-conventions: destructive actions never mutate directly from a menu
    // run. The falsifier for a "just call removeRootDirectory" implementation.
    const deps = makeDeps();
    const disconnect = buildWorkspaceRootLocalActions(deps)[1];
    expect(disconnect?.group).toBe('danger');
    expect(disconnect?.label).toBe('Disconnect…');
    await expect(disconnect?.run(mainRoot as ContextTarget, NO_SERVICES)).resolves.toEqual({
      ok: true,
    });
    expect(deps.onDisconnect).toHaveBeenCalledExactlyOnceWith(mainRoot);
    expect(deps.onSetAsMain).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2 (GREEN): the local actions**

Create `packages/file-explorer-ui/src/context-actions/workspace-root-local-actions.ts`:

```ts
import {
  type AnyContextAction,
  defineContextAction,
  type TargetOf,
} from '@brainstrike/context-actions';
import { Star, Unplug } from 'lucide-react';

export interface WorkspaceRootLocalActionDeps {
  /**
   * STAGED, like the vault's Delete…: this opens the existing
   * `DisconnectRootDialog`; the dialog's confirm performs the removal
   * (ui-conventions: a destructive action never mutates from a menu run).
   */
  readonly onDisconnect: (target: TargetOf<'workspace-root'>) => void;
  /**
   * The WORKSPACE-wide MAIN root (`setMainRoot`, `activeRootIds[0]`) — the
   * role this same header renders as its "Main" badge. NOT the workspace
   * bar's per-thread primary (BST-1393 ruling R1).
   */
  readonly onSetAsMain: (target: TargetOf<'workspace-root'>) => void;
}

/**
 * Surface-local `workspace-root` actions: they close over the file-explorer
 * store and the section's own dialog state, so they travel through
 * `ActionContextMenu`'s `localActions` prop rather than the global registry
 * (`ui-conventions.md` CONTEXT ACTION SYSTEM).
 *
 * `ActionContextMenu` toasts and logs failures centrally, so `run` only ever
 * returns an `ActionOutcome`.
 */
export function buildWorkspaceRootLocalActions({
  onDisconnect,
  onSetAsMain,
}: WorkspaceRootLocalActionDeps): AnyContextAction[] {
  return [
    defineContextAction<'workspace-root'>({
      appliesTo: ['workspace-root'],
      group: 'primary',
      icon: Star,
      id: 'workspace-root.set-as-main',
      // Hidden, not disabled: "make this the Main root" has no meaning for
      // the root that already is one.
      isVisible: (target) => !target.isMain,
      label: 'Set as Main',
      run: (target) => {
        onSetAsMain(target);
        return Promise.resolve({ ok: true });
      },
    }),
    defineContextAction<'workspace-root'>({
      appliesTo: ['workspace-root'],
      group: 'danger',
      icon: Unplug,
      id: 'workspace-root.disconnect',
      label: 'Disconnect…',
      run: (target) => {
        onDisconnect(target);
        return Promise.resolve({ ok: true });
      },
    }),
  ];
}
```

Add to `packages/file-explorer-ui/src/context-actions/index.ts`:

```ts
export {
  buildWorkspaceRootLocalActions,
  type WorkspaceRootLocalActionDeps,
} from './workspace-root-local-actions';
```

- [ ] **Step 3 (GREEN): the header accepts a claim handler**

In `packages/file-explorer-ui/src/components/root-section-header.tsx`, add to `RootSectionHeaderProps` (alphabetical — between `onDisconnect` and `onToggleCollapse`):

```ts
  /**
   * Claims this row's `workspace-root` ContextTarget. Called synchronously in
   * the `contextmenu` event (ui-conventions: targets are event-time
   * snapshots). Absent ⇒ the row claims nothing and `ActionContextMenu`
   * vetoes the open, so there is no menu at all.
   */
  onContextMenu?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
```

Destructure it and put it on the outer row `div` (the one with `data-testid="root-section-header-row"`), alphabetically among that element's props:

```tsx
      data-testid="root-section-header-row"
      onContextMenu={onContextMenu}
```

- [ ] **Step 4 (GREEN): the section wires the menu**

In `packages/file-explorer-ui/src/shell/file-explorer-sidebar.tsx`, extend the imports:

```ts
import { ActionContextMenu, EmptyState, LightweightCheckbox, useContextMenuTarget } from '@brainstrike/ui';
import type { AnyContextAction } from '@brainstrike/context-actions';
import {
  buildWorkspaceRootLocalActions,
  workspaceRootToTarget,
} from '../context-actions';
```

Inside `RootSectionInner` (the component that today renders `<RootSectionHeader …/>` plus `<DisconnectRootDialog …/>`), add — `setMainRoot` comes from the store selector this file already imports:

```tsx
  const setMainRoot = useFileExplorerStoreSelector((s) => s.setMainRoot);
  const rootMenuController = useContextMenuTarget();
  const { setTarget: setRootMenuTarget } = rootMenuController;

  const claimRootTarget = useCallback(() => {
    setRootMenuTarget(
      workspaceRootToTarget({
        // Refinement A (post-Task-2 review): the adapter compares
        // `path !== displayName`; the header's OWN `path` prop is built
        // elsewhere in this file (line ~726-732) by comparing
        // `path !== handle.name`. Those two independent equality checks
        // only agree because we pass `handle.name` as `displayName` here —
        // Task 3's surface test MUST assert this explicitly (claim a web
        // FSA root's target and assert `path: null`, which is only true if
        // this line is exactly `rootDirectoryHandle.name`), not just trust
        // that passing `.name` happens to line up.
        displayName: rootDirectoryHandle.name,
        isMain: rest.mainRootId !== undefined && rest.mainRootId === rootIdentity,
        // [CORRECTED post-Task-1 review, folded into Task 2: NOT "the
        // header's own tooltip rule, reused" — RootSectionHeader has no such
        // rule (see workspace-root-target.ts). This is the adapter's OWN
        // `path !== displayName` normalization doing the work: we pass the
        // raw handle path through whenever truthy, WITHOUT the equality
        // pre-filter file-explorer-sidebar.tsx applies for the header's
        // `path` prop, and rely on `workspaceRootToTarget` to null it out.
        // LIVE-vs-DEAD determination: `DirectoryHandle.path` on web IS
        // `DirectoryHandle.name` by construction (packages/types/src/
        // file-system.ts: "on web `path` is only the directory name"), so
        // for a web FSA root this branch DOES reach the adapter with
        // path === displayName and the normalization fires — it is LIVE,
        // not dead code. Task 3 MUST add a test in
        // root-section-context-menu.test.tsx pinning this: claim the
        // context menu on a web FSA root section and assert the resulting
        // target (or a claimed-target spy) has `path: null`, not the raw
        // handle name.
        //
        // Refinement B (post-Task-2 review): `DirectoryHandle.path` is a
        // REQUIRED `string` (packages/types/src/file-system.ts:134 —
        // `path: string`, not `path?: string`), so the `...({} )` branch
        // below (omitting `path` entirely) is DEFENSIVE-ONLY: it exists so
        // this spread compiles against `WorkspaceRootTargetInput`'s
        // genuinely optional `path`, but no real `DirectoryHandle` reaching
        // this call site is ever expected to have a falsy `path`. The
        // name-equality branch above is the SOLE live path-nulling
        // mechanism for this call site; do not write or imply a test that
        // exercises "no path at all" as a real scenario reached through
        // `rootDirectoryHandle` — that scenario is covered generically by
        // the adapter's own unit test (`workspace-root-target.test.ts`,
        // "reports path: null for an absent path"), not by anything this
        // call site can produce.
        ...(rootDirectoryHandle.path ? { path: rootDirectoryHandle.path } : {}),
        rootId: rootIdentity,
      })
    );
  }, [rootDirectoryHandle.name, rootDirectoryHandle.path, rest.mainRootId, rootIdentity, setRootMenuTarget]);

  const resetRootTarget = useCallback(() => {
    setRootMenuTarget(null);
  }, [setRootMenuTarget]);

  const rootMenuActions = useMemo<readonly AnyContextAction[]>(
    () => [
      ...buildWorkspaceRootLocalActions({
        onDisconnect: () => {
          setIsDisconnectDialogOpen(true);
        },
        onSetAsMain: (target) => {
          setMainRoot(target.rootId);
        },
      }),
      ...(rootActions ?? []),
    ],
    [rootActions, setMainRoot]
  );
```

Wrap ONLY the header (never the tree pane — `OptimizedFileTree` owns its own `ActionContextMenu`, and nesting two Radix context menus would let the outer one open against a stale target):

```tsx
      <ActionContextMenu
        controller={rootMenuController}
        localActions={rootMenuActions}
        onCloseAutoFocus={focusRootHeader}
      >
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: display:contents reset boundary; the handler only clears the claimed target */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: see above — layout-neutral wrapper, not an interactive control */}
        <div className="contents" onContextMenuCapture={resetRootTarget}>
          <RootSectionHeader
            displayName={rootDirectoryHandle.name}
            isCollapsed={isCollapsed}
            isFocused={rest.currentFolderId !== null && rest.currentFolderId === rootIdentity}
            isMain={rest.mainRootId !== undefined && rest.mainRootId === rootIdentity}
            onContextMenu={claimRootTarget}
            onDisconnect={onRemoveRoot ? handleDisconnectRequest : undefined}
            onToggleCollapse={handleToggle}
            {/* …every existing prop unchanged… */}
          />
        </div>
      </ActionContextMenu>
```

`focusRootHeader` satisfies the ui-conventions rule that `onCloseAutoFocus` must never leave focus on `body`:

```tsx
  const headerRowRef = useRef<HTMLDivElement | null>(null);
  const focusRootHeader = useCallback(() => {
    // Radix's delayed trigger restoration is prevented by supplying this
    // callback at all, so it must land focus somewhere real. The header's
    // toggle button is the deterministic live fallback for this surface — it
    // is never virtualized away while the section is mounted.
    headerRowRef.current?.querySelector<HTMLButtonElement>('[data-testid="root-section-header"]')?.focus();
  }, []);
```

…with `ref={headerRowRef}` on the `display: contents` wrapper.

Thread `rootActions` down: add `rootActions?: readonly AnyContextAction[] | undefined` to the sidebar's props interface, pass it into `RootSection`/`RootSectionInner`, and in `file-explorer-panel.tsx` add it to `FileExplorerPanelProps`, to `FileExplorerPanelInner`'s destructure, to the `<FileExplorerSidebar … rootActions={rootActions} />` call, and to the outer `FileExplorerPanel` wrapper's forwarding.

- [ ] **Step 5 (RED→GREEN): the surface test**

Create `packages/file-explorer-ui/src/__tests__/root-section-context-menu.test.tsx`. Read `packages/file-explorer-ui/src/__tests__/file-explorer-sidebar.test.tsx` at HEAD first and reuse its provider harness verbatim (it already mounts `FileExplorerSidebar` with a fake store); this file adds only the menu cases:

```tsx
  it('opens a root menu whose items reflect the claimed target', async () => {
    // …render the sidebar harness with two roots, root-2 being Main…
    const header = screen.getAllByTestId('root-section-header-row')[0];
    if (!header) {
      throw new Error('expected a root header row');
    }
    fireEvent.contextMenu(header);
    expect(await screen.findByText('Set as Main')).toBeInTheDocument();
    expect(screen.getByText('Disconnect…')).toBeInTheDocument();
  });

  it('omits Set as Main on the root that already is Main', async () => {
    // …the Main root's header…
    fireEvent.contextMenu(mainHeader);
    expect(await screen.findByText('Disconnect…')).toBeInTheDocument();
    expect(screen.queryByText('Set as Main')).not.toBeInTheDocument();
  });

  it('Set as Main calls setMainRoot with the row identity and disconnects nothing', async () => {
    fireEvent.contextMenu(header);
    fireEvent.click(await screen.findByText('Set as Main'));
    await waitFor(() => {
      expect(setMainRootMock).toHaveBeenCalledExactlyOnceWith('root-1');
    });
    expect(removeRootMock).not.toHaveBeenCalled();
  });

  it('Disconnect… STAGES the dialog and removes nothing', async () => {
    fireEvent.contextMenu(header);
    fireEvent.click(await screen.findByText('Disconnect…'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(removeRootMock).not.toHaveBeenCalled();
  });

  it('renders injected host actions alongside the local ones', async () => {
    // Proves the `rootActions` seam: an injected action reaches the menu and
    // receives the SAME claimed target.
    const run = vi.fn().mockResolvedValue({ ok: true });
    // …render with rootActions={[defineContextAction({ appliesTo:['workspace-root'],
    //    group:'navigate', id:'test.injected', label:'Injected', run })]}…
    fireEvent.contextMenu(header);
    fireEvent.click(await screen.findByText('Injected'));
    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    expect(run.mock.calls[0]?.[0]).toMatchObject({ kind: 'workspace-root', rootId: 'root-1' });
  });

  it('claims path: null for a web FSA root, proving displayName === handle.name (Refinement A)', async () => {
    // Post-Task-2-review requirement. The adapter compares
    // `path !== displayName` (workspace-root-target.ts); the header's OWN
    // `path` prop is built elsewhere in this file by comparing
    // `path !== handle.name` (file-explorer-sidebar.tsx ~726-732). Those two
    // independently-written equality checks only agree because
    // `claimRootTarget` passes `displayName: rootDirectoryHandle.name` — this
    // test is the falsifier for a future edit that passes a DIFFERENT
    // displayName (e.g. a localized label) and silently breaks the null
    // result. Reuse the `rootActions` spy seam (same as the previous test) to
    // observe the claimed target rather than reaching into internal state.
    //
    // …render a THIRD root section whose `rootDirectoryHandle` is a real web
    // FSA shape: `{ name: 'notes', path: 'notes', platform: 'web' }` — name
    // and path IDENTICAL, per `DirectoryHandle`'s documented web contract
    // (packages/types/src/file-system.ts: "on web `path` is only the
    // directory name"). Do NOT reuse the pre-existing `mockDirectoryHandle`
    // fixture from file-explorer-sidebar.test.tsx — its `path: '/test-directory'`
    // does not equal its `name: 'test-directory'`, so it cannot exercise this
    // branch. Render with rootActions={[defineContextAction({
    //   appliesTo: ['workspace-root'], group: 'navigate', id: 'test.probe',
    //   label: 'Probe', run,
    // })]}…
    const run = vi.fn().mockResolvedValue({ ok: true });
    fireEvent.contextMenu(fsaHeader);
    fireEvent.click(await screen.findByText('Probe'));
    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    // path: null is ONLY possible if displayName reached the adapter equal
    // to the handle's path ('notes' === 'notes') — this assertion IS the
    // Refinement-A pin, not a restatement of it.
    expect(run.mock.calls[0]?.[0]).toMatchObject({ kind: 'workspace-root', path: null });
  });

  it('opens NO menu when a right-click claims nothing', () => {
    // The reset-then-claim protocol's falsifier: right-click the tree
    // container (outside any header) and assert no root menu items appear.
    fireEvent.contextMenu(screen.getByTestId('explorer-scroll-root'));
    expect(screen.queryByText('Disconnect…')).not.toBeInTheDocument();
  });
```

- [ ] **Step 6 (VERIFY)**

```bash
pnpm run type-check
pnpm --filter @brainstrike/file-explorer-ui test
pnpm exec biome check packages/file-explorer-ui/src/shell/file-explorer-sidebar.tsx
pnpm dlx ultracite fix packages/file-explorer-ui/src
npx react-doctor . --scope changed --base <task-2-sha> --verbose -y
```

- [ ] **Step 7: commit**

```bash
git add -A && git commit -m "feat(BST-1393): right-click menu on Explorer root headers

Set as Main (hidden when already Main) and a STAGED Disconnect…, plus a
rootActions injection seam so app-shell can contribute the actions that
need its own bridges. Wraps only the header, never the tree pane, so the
two Radix context menus stay siblings.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: app-shell injects Open in Terminal and New thread here

**Files:** `packages/app-shell/src/workspace-root-context-actions.tsx` (new), `packages/app-shell/src/hooks/use-create-thread-in-folder.ts` (new), `packages/app-shell/src/threads-panel.tsx`, `packages/app-shell/src/explorer-search-tabs.tsx`, `packages/app-shell/src/__tests__/workspace-root-context-actions.test.tsx` (new), `packages/app-shell/src/__tests__/use-create-thread-in-folder.test.ts` (new)

**The two seams being consumed, both verified at the integration tip:**

- **Open in Terminal** — `useTerminalTargetStore.getState().openTerminalAt({ cwd, rootId })` behind `isTerminalBridgeAvailable()`. A workspace ROOT is the simplest case the seam has: it IS its own mount, so `cwd === path` and `rootId` is its own id (the same reasoning `use-workspace-bar-terminal.ts` documents — "a mounted root is its own cwd… both still travel because main authorizes on the first and spawns in the second").
- **New thread here** — `threads-panel.tsx`'s `handleCreateThreadInFolder` is EXACTLY this operation (one `createThread`, then ONE metadata write carrying the whole `operatingRoot*` triple, because the repository rejects a partial triple). Extract it verbatim into a shared hook and have BOTH call sites use it, rather than growing a second, divergent writer.

- [ ] **Step 1 (RED): pin the extracted thread hook**

Create `packages/app-shell/src/__tests__/use-create-thread-in-folder.test.ts` covering: (a) one `createThread` then ONE `updateThreadMetadata` carrying all three `operatingRoot*` keys; (b) `operatingRootPath` OMITTED (not `undefined`) when the folder has no path; (c) a rejected metadata write toasts "Could not bind it to …" and does NOT retry; (d) a rejected `createThread` toasts and never calls `updateThreadMetadata`; (e) a null repository is a no-op.

- [ ] **Step 2 (GREEN): extract the hook**

Create `packages/app-shell/src/hooks/use-create-thread-in-folder.ts` holding the body of `handleCreateThreadInFolder` verbatim (doc comment included), parameterized as:

**(corrected at execution: plan defect — `path?: string | undefined` below does NOT structurally accept `ThreadFolderRow`'s `path: string | null` under `exactOptionalPropertyTypes: true`. Verified directly with `tsc --strict --exactOptionalPropertyTypes`: assigning a `ThreadFolderRow` to a `path?: string | undefined`-shaped binding is a compile error ("Type 'string | null' is not assignable to type 'string | undefined'"), and so is assigning the resulting callback to `onNewThreadInFolder: ((folder: ThreadFolderRow) => void) | null` by parameter contravariance. `ThreadFolderRow.path` is REQUIRED `string | null` (not optional), so `ThreadFolderBinding.path` must match that shape exactly — not the `WorkspaceRootTargetInput`-style optional-key idiom Task 1 uses for a different reason (there, the key is genuinely absent for some callers). Below reflects the corrected type; the hook body is UNCHANGED because it already gates on `folder.path` by truthiness (`...(folder.path ? { operatingRootPath: folder.path } : {})`), which works identically whether `path` is `null` or `undefined`.)**

```ts
export interface ThreadFolderBinding {
  readonly displayName: string;
  readonly path: string | null;
  readonly rootId: string;
}

export function useCreateThreadInFolder(): ((folder: ThreadFolderBinding) => void) | null;
```

It resolves `repository`, `resourceId`, `createThread` and `updateThreadMetadata` from the same stores `threads-panel.tsx` reads them from, and returns `null` while the repository is unresolved (mirroring `onNewThreadInFolder={repository ? … : null}`). Then in `threads-panel.tsx` replace the inline `handleCreateThreadInFolder` `useCallback` with `const handleCreateThreadInFolder = useCreateThreadInFolder();` and pass it straight through — `ThreadFolderRow` now structurally MATCHES `ThreadFolderBinding` exactly (both `path: string | null`, required), so the call site at `:3440` becomes `onNewThreadInFolder={handleCreateThreadInFolder}`.

**Downstream consequence for Step 4's `run` implementation below:** because `ThreadFolderBinding.path` is REQUIRED (not optional), the "New Thread Here" action must pass `path: target.path` directly — `target.path` is already `string | null` on a `workspace-root` target, so no conditional spread is needed or correct there; a conditional spread would OMIT the key when `null`, which is now a missing-required-property error, not a permissible optional omission.

> **Regression floor:** `threads-panel.tsx` is on the `noExcessiveLinesPerFile` allowlist, so this extraction is for correctness (one writer), not for the ceiling. `apps/desktop/e2e/threads-panel-folders.desktop.test.ts` already proves "New thread here" binds; run it in Layer 5 to prove the extraction changed nothing.

- [ ] **Step 3 (RED): pin the injected actions**

Create `packages/app-shell/src/__tests__/workspace-root-context-actions.test.tsx`. Mock the three seams — the file mocks NONE of them today, so the harness must be written, not assumed (`rg -n "terminal-target-store|isTerminalBridgeAvailable|use-create-thread-in-folder" packages/app-shell/src/__tests__` returns nothing):

```tsx
const { createThreadInFolderMock, isTerminalBridgeAvailableMock, openTerminalAtMock } = vi.hoisted(
  () => ({
    createThreadInFolderMock: vi.fn(),
    isTerminalBridgeAvailableMock: vi.fn(() => true),
    openTerminalAtMock: vi.fn(),
  })
);

vi.mock('../terminal-panel/terminal-bridge', () => ({
  isTerminalBridgeAvailable: isTerminalBridgeAvailableMock,
}));
vi.mock('../stores/terminal-target-store', () => ({
  useTerminalTargetStore: { getState: () => ({ openTerminalAt: openTerminalAtMock }) },
}));
vi.mock('../hooks/use-create-thread-in-folder', () => ({
  useCreateThreadInFolder: () => createThreadInFolderMock,
}));
```

Cases:

```ts
  it('opens the terminal at the root itself — cwd IS the root path', async () => {
    const [openTerminal] = renderHook(() => useWorkspaceRootActions()).result.current;
    await openTerminal?.run(desktopRoot, {});
    expect(openTerminalAtMock).toHaveBeenCalledExactlyOnceWith({
      cwd: '/Users/dev/GitHub/brainstrike',
      rootId: 'root-1',
    });
    expect(createThreadInFolderMock).not.toHaveBeenCalled();
  });

  it('omits Open in Terminal entirely when the terminal bridge is absent', () => {
    // The capability gate itself — the case the other two could never observe
    // failing. Web has no window.terminal, therefore no item, never a stub.
    isTerminalBridgeAvailableMock.mockReturnValue(false);
    expect(renderHook(() => useWorkspaceRootActions()).result.current.map((a) => a.id)).toEqual([
      'workspace-root.new-thread-here',
    ]);
  });

  it('hides Open in Terminal for a pathless root', () => { /* isVisible(webRoot) === false */ });

  it('starts a thread bound to the root and opens no terminal', async () => {
    const newThread = renderHook(() => useWorkspaceRootActions()).result.current[1];
    await newThread?.run(desktopRoot, {});
    expect(createThreadInFolderMock).toHaveBeenCalledExactlyOnceWith({
      displayName: 'brainstrike',
      path: '/Users/dev/GitHub/brainstrike',
      rootId: 'root-1',
    });
    expect(openTerminalAtMock).not.toHaveBeenCalled();
  });

  it('omits New thread here while the thread repository is unresolved', () => {
    // useCreateThreadInFolder returns null → absent, not a dead row.
  });

  it('starts a thread for a pathless root, passing path: null explicitly (not omitted)', async () => {
    // (added at execution, alongside the ThreadFolderBinding defect fix
    // above): `target.path` on a `webRoot` is `null`, and `path` is now a
    // REQUIRED field on `ThreadFolderBinding` — the falsifier for a
    // regression back to the conditional-spread-away-when-null shape.
    const newThread = renderHook(() => useWorkspaceRootActions()).result.current[1];
    await newThread?.run(webRoot, {});
    expect(createThreadInFolderMock).toHaveBeenCalledExactlyOnceWith({
      displayName: 'notes',
      path: null,
      rootId: 'root-web-1',
    });
  });
```

- [ ] **Step 4 (GREEN): the hook**

Create `packages/app-shell/src/workspace-root-context-actions.tsx`:

```tsx
/**
 * The two `workspace-root` context actions that need app-shell's own seams,
 * injected into `FileExplorerPanel`'s `rootActions` prop (BST-1393). They
 * cannot live in `file-explorer-ui` beside the other four: that package does
 * not — and must not — depend on `@brainstrike/app-shell`.
 *
 * Both are capability-gated by ABSENCE. `isTerminalBridgeAvailable()` is
 * resolved once per hook instance (the `use-workspace-bar-terminal.ts`
 * idiom), and `useCreateThreadInFolder()` returns `null` until the thread
 * repository resolves — so web renders neither item and a booting desktop
 * renders no dead "New thread here".
 */
import { type AnyContextAction, defineContextAction } from '@brainstrike/context-actions';
import { MessageSquarePlus, SquareTerminal } from 'lucide-react';
import { useMemo } from 'react';
import { useCreateThreadInFolder } from './hooks/use-create-thread-in-folder';
import { useTerminalTargetStore } from './stores/terminal-target-store';
import { isTerminalBridgeAvailable } from './terminal-panel/terminal-bridge';

export function useWorkspaceRootActions(): readonly AnyContextAction[] {
  const terminalAvailable = useMemo(() => isTerminalBridgeAvailable(), []);
  const createThreadInFolder = useCreateThreadInFolder();
  return useMemo(() => {
    const actions: AnyContextAction[] = [];
    if (terminalAvailable) {
      actions.push(
        defineContextAction<'workspace-root'>({
          appliesTo: ['workspace-root'],
          group: 'navigate',
          icon: SquareTerminal,
          id: 'workspace-root.open-in-terminal',
          isVisible: (target) => target.path !== null,
          label: 'Open in Terminal',
          run: (target) => {
            if (target.path === null) {
              return Promise.resolve({ error: 'This folder has no filesystem path.', ok: false });
            }
            // A mounted ROOT is its own cwd, so `rootId` and `path` name the
            // same folder here — the simplest case of the BST-1457 seam. Both
            // still travel: main authorizes on the first and, after a
            // containment check, spawns in the second.
            useTerminalTargetStore.getState().openTerminalAt({ cwd: target.path, rootId: target.rootId });
            return Promise.resolve({ ok: true });
          },
        })
      );
    }
    if (createThreadInFolder) {
      actions.push(
        defineContextAction<'workspace-root'>({
          appliesTo: ['workspace-root'],
          group: 'primary',
          icon: MessageSquarePlus,
          id: 'workspace-root.new-thread-here',
          label: 'New Thread Here',
          run: (target) => {
            // (corrected at execution: `ThreadFolderBinding.path` is
            // REQUIRED `string | null` — see the Step 2 defect note — so
            // this passes `target.path` directly rather than conditionally
            // spreading it away when null.)
            createThreadInFolder({
              displayName: target.displayName,
              path: target.path,
              rootId: target.rootId,
            });
            return Promise.resolve({ ok: true });
          },
        })
      );
    }
    return actions;
  }, [createThreadInFolder, terminalAvailable]);
}
```

- [ ] **Step 5 (GREEN): supply them**

In `packages/app-shell/src/explorer-search-tabs.tsx`:

```tsx
import { useWorkspaceRootActions } from './workspace-root-context-actions';
```

```tsx
  const rootActions = useWorkspaceRootActions();
```

```tsx
        <FileExplorerPanel rootActions={rootActions} selectionActions={importAction} />
```

- [ ] **Step 6 (VERIFY)**

```bash
pnpm run type-check
pnpm --filter @brainstrike/app-shell test
pnpm --filter @brainstrike/file-explorer-ui test
pnpm dlx ultracite fix packages/app-shell/src
npx react-doctor . --scope changed --base <task-3-sha> --verbose -y
```

- [ ] **Step 7: commit**

```bash
git add -A && git commit -m "feat(BST-1393): Open in Terminal and New Thread Here on workspace roots

Consumes the BST-1457 terminal-target seam (a root is its own cwd) and
extracts threads-panel's folder-bound thread creation into one shared hook
so both surfaces keep a single writer of the operatingRoot triple.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Layer 2 — the connect-folder seam, the bridge and the File menu

## Task 5: the `window.workspace` bridge

**Files:** `apps/desktop/src/platform/desktop-ipc-channels.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/types/electron.d.ts`, `packages/app-shell/src/workspace-connect/workspace-connect-bridge.ts` (new), `packages/app-shell/src/__tests__/workspace-connect-bridge.test.ts` (new), `apps/desktop/src/__tests__/preload-runtime-contract.test.ts`

**Interfaces this task lands:**

```ts
// packages/app-shell/src/workspace-connect/workspace-connect-bridge.ts
export type WorkspaceOpenOrigin = 'argv' | 'drop' | 'menu-recent' | 'open-file' | 'second-instance';
export interface WorkspaceOpenPathRequest {
  readonly origin: WorkspaceOpenOrigin;
  readonly path: string;
}
export interface WorkspaceConnectBridge {
  readonly getDroppedPath: (file: File) => string;
  readonly onOpenFolderPicker: (callback: () => void) => () => void;
  readonly onOpenPath: (callback: (request: WorkspaceOpenPathRequest) => void) => () => void;
}
export const WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS: readonly (keyof WorkspaceConnectBridge)[];
export function isWorkspaceOpenPathRequest(value: unknown): value is WorkspaceOpenPathRequest;
export function resolveWorkspaceConnectBridge(): WorkspaceConnectBridge | null;
```

- [ ] **Step 1 (RED): pin the resolver and the payload narrowing**

Create `packages/app-shell/src/__tests__/workspace-connect-bridge.test.ts`, modelled on `packages/app-shell/src/__tests__/terminal-bridge.test.ts` (read it at HEAD for the `window` mutation idiom):

```ts
import { addLogListener, configureLogger, type LogRecord, resetLogger } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWorkspaceOpenPathRequest,
  resolveWorkspaceConnectBridge,
  WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS,
} from '../workspace-connect/workspace-connect-bridge';

interface MutableWindow {
  workspace?: unknown;
}

afterEach(() => {
  (window as MutableWindow).workspace = undefined;
  resetLogger();
  vi.restoreAllMocks();
});

describe('resolveWorkspaceConnectBridge', () => {
  it('is absent on web', () => {
    expect(resolveWorkspaceConnectBridge()).toBeNull();
  });

  it('resolves a fully-formed bridge', () => {
    (window as MutableWindow).workspace = {
      getDroppedPath: vi.fn(),
      onOpenFolderPicker: vi.fn(),
      onOpenPath: vi.fn(),
    };
    expect(resolveWorkspaceConnectBridge()).not.toBeNull();
  });

  it('treats a partial bridge as ABSENT and says which members are missing', () => {
    configureLogger({ console: false });
    (window as MutableWindow).workspace = { onOpenPath: vi.fn() };
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });
    try {
      expect(resolveWorkspaceConnectBridge()).toBeNull();
    } finally {
      unsubscribe();
    }
    expect(
      records.find((record) => record.scope === 'WorkspaceConnectBridge')?.args
    ).toContainEqual({ missing: ['getDroppedPath', 'onOpenFolderPicker'] });
  });

  it('pins the exact required-method set', () => {
    expect([...WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS]).toEqual([
      'getDroppedPath',
      'onOpenFolderPicker',
      'onOpenPath',
    ]);
  });
});

describe('isWorkspaceOpenPathRequest', () => {
  it('accepts a well-formed request', () => {
    expect(isWorkspaceOpenPathRequest({ origin: 'argv', path: '/a/b' })).toBe(true);
  });

  it('rejects every malformed shape rather than coercing it', () => {
    // The IPC boundary is `unknown` + narrowing. An empty path would reach
    // fs:addRootByPath and throw there with a message about grants, which
    // would misdescribe a wiring bug as a permission problem.
    expect(isWorkspaceOpenPathRequest(null)).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'argv' })).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'argv', path: '' })).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'argv', path: 42 })).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'nope', path: '/a' })).toBe(false);
  });
});
```

- [ ] **Step 2 (GREEN): the renderer-side bridge module**

Create `packages/app-shell/src/workspace-connect/workspace-connect-bridge.ts`:

```ts
/**
 * Structural typing + capability resolution for the desktop `window.workspace`
 * bridge (BST-1393, spec §7): the three ways an OS-level gesture becomes a
 * folder this app can be ASKED to connect.
 *
 * Why a bridge of its own rather than a member on `window.platform`
 * (ruling B1): `PLATFORM_BRIDGE_REQUIRED_METHODS` is an EXACT set, and four
 * object literals in `context-action-registry.test.ts` duck-type that bridge —
 * a fourth required member would silently make each of them "malformed" and
 * turn `fs.reveal` off in tests the compiler cannot flag.
 *
 * `getDroppedPath` is deliberately NOT an IPC call: it is a preload-local
 * `webUtils.getPathForFile`. It sits here because all three members exist for
 * the identical job, and splitting a one-function bridge out would double the
 * contract-test surface for no separation (ruling B2).
 *
 * Deliberately dependency-light (logging only) so the desktop preload contract
 * test can import the required-method pin without pulling UI graphs.
 */
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('WorkspaceConnectBridge');

/** Which OS gesture produced the request. Presentation + logging only. */
export type WorkspaceOpenOrigin = 'argv' | 'drop' | 'menu-recent' | 'open-file' | 'second-instance';

const WORKSPACE_OPEN_ORIGINS: readonly WorkspaceOpenOrigin[] = [
  'argv',
  'drop',
  'menu-recent',
  'open-file',
  'second-instance',
];

export interface WorkspaceOpenPathRequest {
  readonly origin: WorkspaceOpenOrigin;
  /** Absolute path main resolved. A REQUEST, never a grant (ruling S1). */
  readonly path: string;
}

export interface WorkspaceConnectBridge {
  /**
   * `webUtils.getPathForFile` for a dropped `File`. Returns `''` when the
   * object is not backed by a file on disk (or is not a `File` at all — the
   * preload catches that documented throw). `''` is a REPORTED outcome the
   * extractor counts and the UI states, never a silent skip.
   */
  readonly getDroppedPath: (file: File) => string;
  /** File ▸ Open Folder… — the renderer runs its ordinary picker flow. */
  readonly onOpenFolderPicker: (callback: () => void) => () => void;
  /** argv / open-file / second-instance / File ▸ Open Recent. */
  readonly onOpenPath: (callback: (request: WorkspaceOpenPathRequest) => void) => () => void;
}

// Compile-time exact-set proof: a missing key fails the build and an excess
// key is rejected, so the pin can never drift from the interface.
const WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHOD_SET = {
  getDroppedPath: true,
  onOpenFolderPicker: true,
  onOpenPath: true,
} as const satisfies Record<keyof WorkspaceConnectBridge, true>;

export const WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS = Object.keys(
  WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof WorkspaceConnectBridge)[];

/**
 * IPC payloads arrive as `unknown`. A malformed one is DROPPED with a log, not
 * coerced: an empty path forwarded to `fs:addRootByPath` would come back as a
 * grant refusal, describing a wiring bug as a permission problem.
 */
export function isWorkspaceOpenPathRequest(value: unknown): value is WorkspaceOpenPathRequest {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const origin = candidate['origin'];
  const requestPath = candidate['path'];
  return (
    typeof requestPath === 'string' &&
    requestPath.length > 0 &&
    typeof origin === 'string' &&
    WORKSPACE_OPEN_ORIGINS.includes(origin as WorkspaceOpenOrigin)
  );
}

export function resolveWorkspaceConnectBridge(): WorkspaceConnectBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { workspace?: Partial<WorkspaceConnectBridge> }).workspace;
  if (!bridge) {
    return null;
  }
  const missing = WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.workspace bridge is malformed; folder-connection surfaces disabled', {
      missing,
    });
    return null;
  }
  return bridge as WorkspaceConnectBridge;
}
```

- [ ] **Step 3 (GREEN): channels**

In `apps/desktop/src/platform/desktop-ipc-channels.ts`, add a `workspace` group (alphabetical among the top-level groups — after `userCommands`, before `worktrees`):

```ts
  workspace: {
    // One-way main→renderer push: File ▸ Open Folder… asks the FOCUSED window
    // to run its ordinary picker flow, so the grant, the recents recording and
    // the mount bookkeeping all stay on one path. NOT an `ipcMain.handle`
    // channel.
    openFolderPicker: 'workspace:open-folder-picker',
    // One-way main→renderer push: argv / open-file / second-instance / File ▸
    // Open Recent ask the FOCUSED window to CONNECT a path. A request, never a
    // grant — the renderer routes it through `fs:addRootByPath`, whose gates
    // decide. NOT an `ipcMain.handle` channel.
    openPath: 'workspace:open-path',
  },
```

- [ ] **Step 4 (GREEN): preload**

In `apps/desktop/src/preload.ts`, add the two locally-declared constants beside the existing `COMMAND_PALETTE_OPEN_EVENT` / `QUICK_OPEN_OPEN_EVENT` block:

```ts
const WORKSPACE_OPEN_FOLDER_PICKER_EVENT = 'workspace:open-folder-picker' as const;
const WORKSPACE_OPEN_PATH_EVENT = 'workspace:open-path' as const;
```

Extend the electron import at the top of the file to bring in `webUtils` alongside `contextBridge` / `ipcRenderer`, then expose the bridge next to the `quickOpen` block (gate it with `shouldExposeBridge('workspace')` — every bridge that carries a capability is gated, and this one gates the drop zone):

```ts
// Low-friction folder connection (BST-1393, spec §7): the app menu's
// Open Folder… / Open Recent, `brainstrike <path>` argv, macOS open-file, and
// resolving a Finder-dropped folder to an absolute path. The two `on*` members
// mirror commandPalette/quickOpen; `getDroppedPath` is preload-local.
if (shouldExposeBridge('workspace')) {
  contextBridge.exposeInMainWorld('workspace', {
    getDroppedPath: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        // Documented throw: the argument was not a File. Reported as "no
        // path", which the renderer counts and states — never a silent skip.
        return '';
      }
    },
    onOpenFolderPicker: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(WORKSPACE_OPEN_FOLDER_PICKER_EVENT, listener);
      return () => {
        ipcRenderer.removeListener(WORKSPACE_OPEN_FOLDER_PICKER_EVENT, listener);
      };
    },
    onOpenPath: (callback: (request: unknown) => void) => {
      const listener = (_event: unknown, request: unknown) => callback(request);
      ipcRenderer.on(WORKSPACE_OPEN_PATH_EVENT, listener);
      return () => {
        ipcRenderer.removeListener(WORKSPACE_OPEN_PATH_EVENT, listener);
      };
    },
  });
}
```

- [ ] **Step 5 (GREEN): the ambient type**

In `apps/desktop/src/types/electron.d.ts`, add alphabetically (after `worktrees` or wherever `w` sorts in that interface):

```ts
    /**
     * Low-friction folder connection (BST-1393). Absent on web — consumers
     * capability-check it via `resolveWorkspaceConnectBridge()`. The exposed
     * key set is pinned to `WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS` by the
     * preload-runtime contract test.
     */
    workspace?: import('@brainstrike/app-shell/workspace-connect/workspace-connect-bridge').WorkspaceConnectBridge;
```

> If `@brainstrike/app-shell` has no subpath export reaching that module, add one to `packages/app-shell/package.json` alongside the existing `./terminal-panel/availability` entry — the SAME reason it exists: the desktop contract test and the ambient type must reach the pin without importing the UI barrel. Verify with `rg -n '"./terminal-panel' packages/app-shell/package.json` and mirror it exactly.

- [ ] **Step 6 (RED→GREEN): the contract test**

In `apps/desktop/src/__tests__/preload-runtime-contract.test.ts`:

1. add both constants to the `expectedConstants` map:

```ts
  WORKSPACE_OPEN_FOLDER_PICKER_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.workspace.openFolderPicker,
  WORKSPACE_OPEN_PATH_EVENT: DESKTOP_PRELOAD_IPC_CHANNELS.workspace.openPath,
```

2. add the bridge to `expectedBridgeMethods`:

```ts
  workspace: WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS,
```

Run it and watch it fail before Steps 4–5 land, pass after:

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/preload-runtime-contract.test.ts
```

- [ ] **Step 7 (VERIFY + commit)**

```bash
pnpm run type-check
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/preload-runtime-contract.test.ts
pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/workspace-connect-bridge.test.ts
pnpm dlx ultracite fix apps/desktop/src/preload.ts apps/desktop/src/platform/desktop-ipc-channels.ts apps/desktop/src/types/electron.d.ts packages/app-shell/src/workspace-connect
```

```bash
git add -A && git commit -m "feat(BST-1393): add the window.workspace connection bridge

Three members behind one exact-set pin: the two File-menu pushes and the
preload-local webUtils path resolution for dropped folders. A new bridge
rather than a fourth window.platform member, which four registry-test
fixtures duck-type and would silently invalidate.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: the renderer connect-folder seam and its refusal contract

**Files:** `packages/app-shell/src/workspace-connect/use-connect-folder.tsx` (new), `packages/app-shell/src/workspace-connect/workspace-connect-host.tsx` (new), `apps/desktop/src/renderer/components/root-layout-content.tsx`, `packages/app-shell/src/__tests__/use-connect-folder.test.tsx` (new), `packages/app-shell/src/__tests__/workspace-connect-host.test.tsx` (new)

**This is the ONE seam every entry point converges on.** Nothing else in W6 calls `addRootDirectoryByPath` or `addRootDirectory`.

- [ ] **Step 1 (RED): pin the refusal contract**

Create `packages/app-shell/src/__tests__/use-connect-folder.test.tsx`. Mock `@brainstrike/file-explorer-ui/shell`'s `useFileSystem` and `@brainstrike/ui`'s `toast` with `vi.hoisted` mocks. Cases:

```ts
  it('mounts a granted path through the picker-less seam', async () => {
    addRootDirectoryByPathMock.mockResolvedValue({ name: 'brainstrike', path: '/w/bs' });
    await result.current.connectPath({ origin: 'argv', path: '/w/bs' });
    expect(addRootDirectoryByPathMock).toHaveBeenCalledExactlyOnceWith('/w/bs');
    expect(addRootDirectoryMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('REFUSES a never-granted path and offers the picker as the remedy', async () => {
    // The core of ruling S1: no silent grant, and the remedy is one click.
    addRootDirectoryByPathMock.mockRejectedValue(
      new Error('Folder was never granted in this app; use Add Folder to grant it.')
    );
    await result.current.connectPath({ origin: 'open-file', path: '/w/new' });
    expect(addRootDirectoryMock).not.toHaveBeenCalled();
    const [call] = toastMock.mock.calls;
    expect(call?.[0]).toMatchObject({
      persistent: true,
      title: 'BrainStrike has not been granted access to this folder',
      variant: 'destructive',
    });
    expect(String(call?.[0]?.description)).toContain('/w/new');
    expect(call?.[0]?.action).toBeDefined();
  });

  it('matches the managed-but-unauthorized refusal on the same remedy', async () => {
    addRootDirectoryByPathMock.mockRejectedValue(
      new Error(
        'Folder was never granted in this app and is not a BrainStrike-managed worktree; use Add Folder to grant it.'
      )
    );
    await result.current.connectPath({ origin: 'argv', path: '/w/wt' });
    expect(toastMock.mock.calls[0]?.[0]?.action).toBeDefined();
  });

  it('does NOT offer the grant remedy for a missing folder', async () => {
    // [D9]'s "Folder not found" half: a recents path whose folder is gone is
    // not a grant problem, and offering "Add folder…" would misdescribe it.
    addRootDirectoryByPathMock.mockRejectedValue(new Error('ENOENT: no such file or directory'));
    await result.current.connectPath({ origin: 'menu-recent', path: '/w/gone' });
    const [call] = toastMock.mock.calls;
    expect(call?.[0]?.action).toBeUndefined();
    expect(String(call?.[0]?.description)).toContain('ENOENT');
  });

  it('reports a null handle rather than pretending the folder connected', async () => {
    addRootDirectoryByPathMock.mockResolvedValue(null);
    await result.current.connectPath({ origin: 'argv', path: '/w/bs' });
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('is ABSENT when the platform has no picker-less capability', () => {
    // Web: `addRootDirectoryByPath` is undefined. `connectPath` must not exist
    // rather than exist-and-no-op.
    expect(result.current.connectPath).toBeUndefined();
  });

  it('openPicker runs the ordinary Add Folder flow and toasts its failure', async () => {
    addRootDirectoryMock.mockRejectedValue(new Error('nope'));
    await result.current.openPicker();
    expect(addRootDirectoryMock).toHaveBeenCalledTimes(1);
    expect(addRootDirectoryByPathMock).not.toHaveBeenCalled();
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({ variant: 'destructive' });
  });
```

- [ ] **Step 2 (GREEN): the hook**

Create `packages/app-shell/src/workspace-connect/use-connect-folder.tsx` (JSX — see the extension note below):

```ts
/**
 * The ONE seam every W6 entry point converges on (BST-1393, spec §7): the
 * File menu, `brainstrike <path>` argv, macOS `open-file`, `second-instance`
 * argv, File ▸ Open Recent, and a Finder folder drop.
 *
 * SECURITY POSTURE (ruling S1). A path from any of these is a REQUEST, never a
 * grant. `open-file` and argv are attacker-influencable — any other process can
 * run `open -a BrainStrike <path>` — and a mounted root is read access for the
 * agent, so this hook never records a grant. It calls the existing picker-less
 * `addRootDirectoryByPath`, whose TWO main-side gates (the recent-roots ledger,
 * then the managed-worktree authorizer) decide, and renders a refusal that
 * names the folder and offers the REAL picker.
 *
 * That is not the friction it looks like: the ledger holds up to 50 previously
 * granted folders and a disconnect does not revoke a grant, so `brainstrike .`
 * in any repo you have ever opened just works. Only a genuinely new folder
 * costs one picker confirmation.
 *
 * Extracted from `workspace-connect-host.tsx` so the host stays a mount point
 * and this stays testable without a React tree — and so neither file carries
 * the whole gate + toast + narrowing weight at once (Biome
 * `noExcessiveCognitiveComplexity`, pre-authorized remedy).
 */
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import { toast, ToastAction } from '@brainstrike/ui';
import { useCallback } from 'react';
import type { WorkspaceOpenPathRequest } from './workspace-connect-bridge';

const logger = createLogger('ConnectFolder');

/**
 * The two refusal messages `resolveGrantedRootHandle` throws
 * (`apps/desktop/src/ipc-domains/workspace-recent-roots.ts`) when neither
 * picker-less grant fires. Duplicated as literals rather than imported: errors
 * cross the main↔renderer boundary as plain strings, and `apps/desktop` is not
 * a dependency this package can import from — the same reasoning
 * `worktree-map-surface.tsx` records for the identical constant. If either
 * message changes, this match silently stops firing and the refusal degrades
 * to the raw error text (never to a WRONG remedy).
 */
const NEVER_GRANTED_MESSAGES: readonly string[] = [
  'Folder was never granted in this app; use Add Folder to grant it.',
  'Folder was never granted in this app and is not a BrainStrike-managed worktree; use Add Folder to grant it.',
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ConnectFolderApi {
  /**
   * Present only when the platform can mount a previously granted path
   * without a picker (desktop). Web omits it — no dead entry points.
   */
  readonly connectPath?: ((request: WorkspaceOpenPathRequest) => Promise<void>) | undefined;
  /** The ordinary OS picker — the same call the Folder chip's Add folder… makes. */
  readonly openPicker: () => Promise<void>;
}

export function useConnectFolder(): ConnectFolderApi {
  const fileSystem = useFileSystem();
  const addRootDirectory = fileSystem.addRootDirectory;
  const addRootDirectoryByPath = fileSystem.addRootDirectoryByPath;

  const openPicker = useCallback(async (): Promise<void> => {
    try {
      await addRootDirectory();
    } catch (error: unknown) {
      logger.error('Open Folder failed', { error });
      toast({
        description: messageOf(error),
        title: 'Could not open that folder',
        variant: 'destructive',
      });
    }
  }, [addRootDirectory]);

  const connectPath = useCallback(
    async ({ origin, path }: WorkspaceOpenPathRequest): Promise<void> => {
      if (!addRootDirectoryByPath) {
        // Structurally unreachable: the caller only exists behind the desktop
        // bridge. Loud rather than a silent no-op.
        logger.error('Folder connection requested without the picker-less capability', {
          origin,
          path,
        });
        return;
      }
      try {
        const handle = await addRootDirectoryByPath(path);
        if (!handle) {
          toast({
            description: `${path} could not be connected as a workspace folder.`,
            title: 'Could not open that folder',
            variant: 'destructive',
          });
        }
      } catch (error: unknown) {
        const message = messageOf(error);
        logger.warn('Folder connection refused', { message, origin, path });
        if (NEVER_GRANTED_MESSAGES.includes(message)) {
          toast({
            action: (
              <ToastAction
                altText="Choose this folder in the system picker to grant access"
                data-testid="workspace-connect-grant-action"
                onClick={() => void openPicker()}
              >
                Add folder…
              </ToastAction>
            ),
            description: `BrainStrike has never been granted access to ${path}. Choose it with “Add folder…” to grant access — this is the same confirmation the folder picker asks for.`,
            // Persistent for the same reason the rewind redo toast is: this
            // toast IS the remedy, and a 5s default would strand it.
            persistent: true,
            title: 'BrainStrike has not been granted access to this folder',
            variant: 'destructive',
          });
          return;
        }
        toast({
          description: message,
          title: 'Could not open that folder',
          variant: 'destructive',
        });
      }
    },
    [addRootDirectoryByPath, openPicker]
  );

  // The CAPABILITY decides whether the entry point exists — gating the spread
  // on `addRootDirectoryByPath` rather than on the callback keeps the
  // render-time condition free of the callback's own deps.
  return { openPicker, ...(addRootDirectoryByPath ? { connectPath } : {}) };
}
```

> **Note for the implementer:** this file contains JSX (`<ToastAction>`), so it must be named `use-connect-folder.tsx`, not `.ts`. Filenames stay kebab-case; the `use-*` hook convention is unaffected by the extension. Update the Files list accordingly and keep the import specifier extensionless.

- [ ] **Step 3 (GREEN): the host**

Create `packages/app-shell/src/workspace-connect/workspace-connect-host.tsx`:

```tsx
/**
 * Mounts the desktop folder-connection subscriptions ONCE at the visible-UI
 * root (BST-1393). Same shape and same mounting rule as `CommandPaletteHost` /
 * `QuickOpenHost`: rendered only from `RootLayoutContent`, which only the
 * visible-UI renderer mounts, so the hidden embedding/llm/chunking hosts never
 * reach it and need no role check here.
 *
 * Renders nothing. Web resolves no bridge and subscribes to nothing.
 */
import { type ReactElement, useEffect } from 'react';
import { useConnectFolder } from './use-connect-folder';
import {
  isWorkspaceOpenPathRequest,
  resolveWorkspaceConnectBridge,
} from './workspace-connect-bridge';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('WorkspaceConnectHost');

export function WorkspaceConnectHost(): ReactElement | null {
  const { connectPath, openPicker } = useConnectFolder();

  useEffect(() => {
    const bridge = resolveWorkspaceConnectBridge();
    if (!bridge) {
      return;
    }
    return bridge.onOpenFolderPicker(() => {
      void openPicker();
    });
  }, [openPicker]);

  useEffect(() => {
    const bridge = resolveWorkspaceConnectBridge();
    if (!(bridge && connectPath)) {
      return;
    }
    return bridge.onOpenPath((request: unknown) => {
      if (!isWorkspaceOpenPathRequest(request)) {
        // Dropped, not coerced: an empty path forwarded to fs:addRootByPath
        // would come back as a grant refusal and describe a wiring bug as a
        // permission problem.
        logger.error('Ignored a malformed workspace open-path request', { request });
        return;
      }
      void connectPath(request);
    });
  }, [connectPath]);

  return null;
}
```

- [ ] **Step 4 (GREEN): mount it**

**(corrected at execution: defect #4 — `CommandPaletteHost` and `QuickOpenHost` do NOT live in `apps/desktop/src/renderer/components/root-layout-content.tsx`; they are mounted in the SHARED `packages/app-shell/src/root-layout-content.tsx` (verified: `grep -n "CommandPaletteHost\|QuickOpenHost"` returns hits only in the app-shell file, none in the desktop one). The desktop file is a thinner wrapper OUTSIDE `FileSystemProvider`'s subtree (it wraps `AppLayout`, which is where the provider tree lives), so mounting `WorkspaceConnectHost` there as originally written would throw on first render the first time it calls `useFileSystem()`. Mount it in `packages/app-shell/src/root-layout-content.tsx` instead, as a sibling of the existing `<CommandPaletteHost />` / `<QuickOpenHost />` renders — inside the same subtree those two already rely on.)**

In `packages/app-shell/src/root-layout-content.tsx`, import `WorkspaceConnectHost` and render it as a sibling of the existing `CommandPaletteHost` / `QuickOpenHost` mounts. Export it from `packages/app-shell/src/index.ts` beside those two.

**Desktop-only by mounting, not by check:** `apps/web` never renders it. Even if it did, `resolveWorkspaceConnectBridge()` returns `null` there.

- [ ] **Step 5 (RED→GREEN): the host test**

`packages/app-shell/src/__tests__/workspace-connect-host.test.tsx`, with mocked `useConnectFolder`: (a) both subscriptions are registered exactly once on a fully-formed bridge and BOTH unsubscribes run on unmount; (b) neither is registered on web (no bridge); (c) `onOpenPath` is not subscribed when `connectPath` is absent; (d) a malformed payload logs at error and calls `connectPath` zero times; (e) a well-formed payload calls `connectPath` exactly once with the exact request.

- [ ] **Step 6 (VERIFY + commit)**

```bash
pnpm run type-check
pnpm --filter @brainstrike/app-shell test
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/renderer
pnpm dlx ultracite fix packages/app-shell/src/workspace-connect apps/desktop/src/renderer/components/root-layout-content.tsx
npx react-doctor . --scope changed --base <task-5-sha> --verbose -y
```

```bash
git add -A && git commit -m "feat(BST-1393): one connect-folder seam with an honest refusal

Every W6 entry point routes through fs:addRootByPath. A never-granted path
is refused with a persistent toast naming the folder and an Add folder…
action that opens the real picker — no third picker-less door on a path
another process can hand us.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: File ▸ Open Folder… (⌘O) and Open Recent

**Files:** `apps/desktop/src/application-file-menu.ts` (new), `apps/desktop/src/main.ts`, `apps/desktop/src/ipc-domains/file-system-ipc.ts`, `apps/desktop/src/__tests__/application-file-menu.test.ts` (new), `apps/desktop/src/__tests__/ipc-domains/file-system-ipc-root-granted.test.ts` (new)

- [ ] **Step 1 (RED): pin the pure builder**

Create `apps/desktop/src/__tests__/application-file-menu.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildFileMenuTemplate, FILE_MENU_IDS } from '../application-file-menu';

function submenuOf(template: Electron.MenuItemConstructorOptions) {
  const submenu = template.submenu;
  if (!Array.isArray(submenu)) {
    throw new Error('File menu must carry an array submenu');
  }
  return submenu;
}

describe('buildFileMenuTemplate', () => {
  it('labels the menu File and leads with Open Folder…', () => {
    const template = buildFileMenuTemplate({
      onClearRecents: vi.fn(),
      onOpenFolder: vi.fn(),
      onOpenRecentPath: vi.fn(),
      recentPaths: [],
    });
    expect(template.label).toBe('File');
    const [openFolder] = submenuOf(template);
    expect(openFolder?.id).toBe(FILE_MENU_IDS.openFolder);
    expect(openFolder?.label).toBe('Open Folder…');
    expect(openFolder?.accelerator).toBe(
      process.platform === 'darwin' ? 'Cmd+O' : 'Ctrl+O'
    );
  });

  it('projects each recent path to a row labelled by its basename', () => {
    const onOpenRecentPath = vi.fn();
    const template = buildFileMenuTemplate({
      onClearRecents: vi.fn(),
      onOpenFolder: vi.fn(),
      onOpenRecentPath,
      recentPaths: ['/Users/dev/GitHub/brainstrike', '/Users/dev/notes'],
    });
    const recent = submenuOf(template).find((item) => item.id === FILE_MENU_IDS.openRecent);
    const rows = Array.isArray(recent?.submenu) ? recent.submenu : [];
    expect(rows.slice(0, 2).map((row) => row.label)).toEqual(['brainstrike', 'notes']);
    // The full path is the tooltip, so two same-named folders stay tellable
    // apart — the exact ambiguity the workspace bar's recents also faces.
    expect(rows[0]?.toolTip).toBe('/Users/dev/GitHub/brainstrike');
    rows[0]?.click?.(
      {} as Electron.MenuItem,
      undefined,
      {} as Electron.KeyboardEvent
    );
    expect(onOpenRecentPath).toHaveBeenCalledExactlyOnceWith('/Users/dev/GitHub/brainstrike');
  });

  it('caps the projection and keeps it newest-first', () => {
    const paths = Array.from({ length: 20 }, (_, index) => `/w/repo-${index}`);
    const recent = submenuOf(
      buildFileMenuTemplate({
        onClearRecents: vi.fn(),
        onOpenFolder: vi.fn(),
        onOpenRecentPath: vi.fn(),
        recentPaths: paths,
      })
    ).find((item) => item.id === FILE_MENU_IDS.openRecent);
    const rows = Array.isArray(recent?.submenu) ? recent.submenu : [];
    // 10 folders + separator + Clear Menu. The ledger cap is 50 (storage
    // hygiene); a 50-row menu is not a menu.
    expect(rows).toHaveLength(12);
    expect(rows[0]?.label).toBe('repo-0');
  });

  it('DISABLES Open Recent when the ledger is empty rather than hiding it', () => {
    // The one sanctioned disabled item in W6: the menu's shape must not
    // change under the user between launches, and "no recent folders yet" is
    // transient state, not a missing capability.
    const recent = submenuOf(
      buildFileMenuTemplate({
        onClearRecents: vi.fn(),
        onOpenFolder: vi.fn(),
        onOpenRecentPath: vi.fn(),
        recentPaths: [],
      })
    ).find((item) => item.id === FILE_MENU_IDS.openRecent);
    expect(recent?.enabled).toBe(false);
    expect(Array.isArray(recent?.submenu) ? recent.submenu : []).toHaveLength(0);
  });

  it('routes Clear Menu to its own dep', () => {
    const onClearRecents = vi.fn();
    const onOpenRecentPath = vi.fn();
    const recent = submenuOf(
      buildFileMenuTemplate({
        onClearRecents,
        onOpenFolder: vi.fn(),
        onOpenRecentPath,
        recentPaths: ['/w/a'],
      })
    ).find((item) => item.id === FILE_MENU_IDS.openRecent);
    const rows = Array.isArray(recent?.submenu) ? recent.submenu : [];
    const clear = rows.at(-1);
    expect(clear?.label).toBe('Clear Menu');
    clear?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    expect(onClearRecents).toHaveBeenCalledTimes(1);
    expect(onOpenRecentPath).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2 (GREEN): the builder**

Create `apps/desktop/src/application-file-menu.ts`:

```ts
import path from 'node:path';

/**
 * The File submenu (BST-1393, spec §7). Pure and dependency-free so it is the
 * unit under test — labels, accelerators, ids, the recents projection and the
 * click routing — without importing `main.ts`'s ~850-line boot closure.
 *
 * Only THIS submenu is extracted (ruling M1): the other three close over
 * `logger`, `noteNextWindowReload`, `resetDesktopDatabaseProfile` and a
 * module-level in-flight flag, and extracting them would be a refactor of a
 * hot file for zero W6 coverage.
 *
 * Ids exist so a desktop E2E can drive the items through
 * `Menu.getApplicationMenu().getMenuItemById(...)` — the application menu is
 * not reachable from Playwright's page context.
 */
export const FILE_MENU_IDS = {
  openFolder: 'file-open-folder',
  openRecent: 'file-open-recent',
} as const;

/**
 * How many ledger entries the menu shows. `RECENT_ROOTS_LIMIT` is 50 —
 * deliberately far above realistic mount counts so connected roots cannot
 * evict disconnected grants — which is a storage bound, not a menu bound.
 */
export const FILE_MENU_RECENT_LIMIT = 10;

export interface FileMenuDeps {
  readonly onClearRecents: () => void;
  readonly onOpenFolder: () => void;
  readonly onOpenRecentPath: (recentPath: string) => void;
  /** Newest-first, exactly as `listRecentRootEntries` orders them. */
  readonly recentPaths: readonly string[];
}

export function buildFileMenuTemplate({
  onClearRecents,
  onOpenFolder,
  onOpenRecentPath,
  recentPaths,
}: FileMenuDeps): Electron.MenuItemConstructorOptions {
  const visible = recentPaths.slice(0, FILE_MENU_RECENT_LIMIT);
  const recentSubmenu: Electron.MenuItemConstructorOptions[] =
    visible.length === 0
      ? []
      : [
          ...visible.map((recentPath) => ({
            click: () => {
              onOpenRecentPath(recentPath);
            },
            // Basename reads; the full path disambiguates two same-named
            // folders without making every row a wall of text.
            label: path.basename(recentPath) || recentPath,
            toolTip: recentPath,
          })),
          { type: 'separator' as const },
          {
            click: () => {
              onClearRecents();
            },
            label: 'Clear Menu',
          },
        ];

  return {
    label: 'File',
    submenu: [
      {
        // Matches the repo's explicit per-platform accelerator style; the
        // existing View items are written the same way rather than CmdOrCtrl.
        accelerator: process.platform === 'darwin' ? 'Cmd+O' : 'Ctrl+O',
        click: () => {
          onOpenFolder();
        },
        id: FILE_MENU_IDS.openFolder,
        label: 'Open Folder…',
      },
      {
        // Disabled, not hidden: an empty ledger is transient state, and a menu
        // whose shape changes between launches is worse than a greyed row.
        enabled: recentSubmenu.length > 0,
        id: FILE_MENU_IDS.openRecent,
        label: 'Open Recent',
        submenu: recentSubmenu,
      },
    ],
  };
}
```

- [ ] **Step 3 (GREEN): the grant notification seam**

In `apps/desktop/src/ipc-domains/file-system-ipc.ts`, add to `RegisterFileSystemIpcHandlersOptions`:

```ts
  /**
   * Fired after a successful grant-recording mount (BST-1393). main uses it to
   * push the folder into the OS recent-documents list and to rebuild the File
   * menu's Open Recent projection. Optional so every existing caller and test
   * is unaffected; a throwing subscriber must never fail the mount that
   * succeeded, so the call is wrapped.
   */
  readonly onWorkspaceRootGranted?: ((grantedPath: string) => void) | undefined;
```

Destructure it and add a local notifier, then call it from the two mount handlers:

```ts
  const notifyRootGranted = (grantedPath: string): void => {
    try {
      onWorkspaceRootGranted?.(grantedPath);
    } catch (error) {
      logger.warn('workspace-root grant subscriber threw', { error });
    }
  };
```

```ts
  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.addRoot, async () => {
    const descriptor = await addSelectedRoot();
    if (descriptor?.path) {
      notifyRootGranted(descriptor.path);
    }
    return descriptor;
  });
```

```ts
      const descriptor = await roots.addRootByPath(requestedPath);
      if (descriptor.path) {
        notifyRootGranted(descriptor.path);
      }
      return descriptor;
```

> **Read `addSelectedRoot` at HEAD before applying** — confirm its return type (it may resolve `RootDescriptor | null`) and adjust the guard rather than assuming. `rg -n "addSelectedRoot" apps/desktop/src/ipc-domains/file-system-ipc.ts`.

New test `apps/desktop/src/__tests__/ipc-domains/file-system-ipc-root-granted.test.ts`: a successful `fs:addRootByPath` fires the callback exactly once with the descriptor path; a rejected one fires it zero times; a THROWING subscriber does not fail the invoke.

- [ ] **Step 4 (GREEN): wire main**

In `apps/desktop/src/main.ts`, inside the `whenReady` closure, replace the single `Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));` with a rebuildable form. Insert the File submenu at index 1 (after `Application`, before `Edit`):

```ts
      const pushToFocusedWindow = (
        browserWindow: Electron.BrowserWindow | undefined,
        channel: string,
        payload?: unknown
      ): void => {
        // Same focused-window routing the Cmd+K / Cmd+P items already use:
        // hidden host windows are never focused and never register the
        // renderer listener, so this is a no-op there.
        const targetWindow =
          browserWindow instanceof BrowserWindow ? browserWindow : BrowserWindow.getFocusedWindow();
        if (!targetWindow || targetWindow.isDestroyed()) {
          return;
        }
        targetWindow.webContents.send(channel, payload);
      };

      let applicationMenuRebuildScheduled = false;
      const rebuildApplicationMenu = async (): Promise<void> => {
        const recents = await listWorkspaceRecentRootPaths();
        const template = [...menuTemplate];
        template.splice(1, template[1]?.label === 'File' ? 1 : 0, buildFileMenuTemplate({
          onClearRecents: () => {
            // OS-level only. The app's own `recentRootsList` ledger is what
            // authorizes the picker-less mount, and clearing it here would
            // silently revoke grants from a menu item labelled "Clear Menu".
            // Emptying the app ledger is "Remove from recents" — still
            // deferred (spec §7 [D9]).
            app.clearRecentDocuments();
          },
          onOpenFolder: () => {
            pushToFocusedWindow(undefined, DESKTOP_IPC_CHANNELS.workspace.openFolderPicker);
          },
          onOpenRecentPath: (recentPath) => {
            pushToFocusedWindow(undefined, DESKTOP_IPC_CHANNELS.workspace.openPath, {
              origin: 'menu-recent',
              path: recentPath,
            });
          },
          recentPaths: recents,
        }));
        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
      };

      const scheduleApplicationMenuRebuild = (): void => {
        // Coalesced: a restore mounts many roots in a burst, and rebuilding
        // the whole application menu per root would thrash the menu bar.
        if (applicationMenuRebuildScheduled) {
          return;
        }
        applicationMenuRebuildScheduled = true;
        setTimeout(() => {
          applicationMenuRebuildScheduled = false;
          rebuildApplicationMenu().catch((error: unknown) => {
            logger.warn('Failed to rebuild the application menu', { error });
          });
        }, 250);
      };

      await rebuildApplicationMenu();
```

`listWorkspaceRecentRootPaths` is a thin main-side read of the same ledger the IPC handler serves — add it beside the other boot helpers:

```ts
const listWorkspaceRecentRootPaths = async (): Promise<readonly string[]> => {
  try {
    return (await listRecentRootEntries(desktopStorageAdapter)).map((entry) => entry.path);
  } catch (error) {
    // A menu that cannot list recents still opens folders; a boot that dies
    // on a storage read does not. Logged, never silent.
    logger.warn('Could not read the recent workspace folders for the File menu', { error });
    return [];
  }
};
```

> **Read at HEAD before applying:** the exact identifier `main.ts` uses for the storage adapter it hands to `registerIpcHandlers` (`rg -n "storage" apps/desktop/src/ipc-handlers.ts | head -20`) and substitute it for `desktopStorageAdapter`. Do not invent one.

Finally, pass the grant subscriber down through `registerIpcHandlers` to `registerFileSystemIpcHandlers`:

```ts
  onWorkspaceRootGranted: (grantedPath: string) => {
    // Spec §7's explicit ask. This feeds the macOS Dock menu and the Windows
    // jump list, whose clicks arrive back as `open-file` / argv — the entry
    // points Layer 3 handles.
    app.addRecentDocument(grantedPath);
    scheduleApplicationMenuRebuild();
  },
```

> **Ordering caveat to verify at execution:** `registerIpcHandlers` is called before the menu block, so `scheduleApplicationMenuRebuild` must be reachable from it. If the two live in different closures, hold the subscriber in a module-level `let pendingRootGrantSubscriber` that the menu block assigns — do NOT move the menu construction earlier (it would then read the ledger before `restoreRoots`).

- [ ] **Step 5 (VERIFY + commit)**

```bash
pnpm run type-check
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/application-file-menu.test.ts
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/main src/__tests__/ipc-domains
pnpm dlx ultracite fix apps/desktop/src/application-file-menu.ts apps/desktop/src/main.ts apps/desktop/src/ipc-domains/file-system-ipc.ts
```

```bash
git add -A && git commit -m "feat(BST-1393): File menu with Open Folder (Cmd+O) and Open Recent

Open Folder pushes to the focused window so the renderer's ordinary picker
flow stays the single grant path. Open Recent projects main's own ledger and
rebuilds on every grant; Clear Menu clears only the OS list, never the
grants that authorize a picker-less mount.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 8 (ruled IN at plan review): the ⌘K "Open folder…" global command**

The targetless-command idiom is `createGlobalCommands`/`GlobalCommandHandlers` (`packages/context-actions/src/commands/global-commands.ts`, wired at `command-registry.ts:48`); its existing `openQuickOpen` member is the documented precedent. (`bridgeActionToCommand` is the WRONG idiom here — it invokes `getTarget()` eagerly and returns `null` for a targetless command, dropping it from the palette.) Three edits, mirroring `openQuickOpen` exactly:

1. `GlobalCommandHandlers` gains `readonly openFolder?: (() => void) | undefined;` (alphabetical among its members).
2. `createGlobalCommands`'s array gains one entry: id `'global.open-folder'`, title `'Open folder…'`, `run: () => handlers.openFolder?.()`, `isAvailable: () => handlers.openFolder !== undefined` — copy `openQuickOpen`'s entry shape verbatim, changing only id/title/handler.
3. The app-shell wiring site that supplies `GlobalCommandHandlers` (find the `openQuickOpen` supply point; supply `openFolder` beside it) points at Task 6's `connectPath` picker flow — the SAME single grant path, no new door.

Tests, one each way in the file that already tests `createGlobalCommands`: handler supplied → the command is available and `run` calls it; handler absent → `isAvailable()` is false (the web/no-capability case, absent-not-disabled). Re-run that suite + ultracite on the three touched files; amend this task's commit or add `feat(BST-1393): Open folder command in the palette`.

---

# Layer 3 — `brainstrike <path>`, `open-file`, `second-instance`

## Task 8: the pure argv → folder-candidates helper

**Files:** `apps/desktop/src/folder-argv.ts` (new), `apps/desktop/src/__tests__/folder-argv.test.ts` (new)

Modelled on `apps/desktop/src/desktop-launch-mode.ts` + `desktop-launch-mode.test.ts`: a pure, injectable-input function with its own unit test, so the parse is provably correct without booting Electron.

- [ ] **Step 1 (RED)**

Create `apps/desktop/src/__tests__/folder-argv.test.ts`:

```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFolderCandidatesFromArgv } from '../folder-argv';

const CWD = path.resolve('/work');

describe('resolveFolderCandidatesFromArgv', () => {
  it('takes a single positional path from a PACKAGED launch', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/Applications/BrainStrike.app/Contents/MacOS/BrainStrike', '/work/repo'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('skips the app-path argument on an UNPACKAGED launch', () => {
    // `electron .` puts the app directory at argv[1]. Treating it as a folder
    // would mount the repo on every dev launch — the falsifier for a naive
    // "everything after argv[0]" parse.
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/node_modules/electron/dist/electron', '/repo/apps/desktop', '/work/repo'],
        isPackaged: false,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('resolves a relative path against the working directory', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/app/BrainStrike', '.'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([CWD]);
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/app/BrainStrike', 'repo'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('ignores every switch, including Chromium and BrainStrike ones', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        argv: [
          '/app/BrainStrike',
          '--brainstrike-desktop-launch-mode=built',
          '--inspect=9222',
          '-v',
          '--',
          '/work/repo',
        ],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('dedupes paths that differ only by trailing separator', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/app/BrainStrike', '/work/repo', '/work/repo/'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('returns nothing for a bare launch', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/app/BrainStrike'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([]);
  });

  it('never emits an empty or whitespace-only candidate', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/app/BrainStrike', '', '   '],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([]);
  });
});
```

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/folder-argv.test.ts
```

- [ ] **Step 2 (GREEN)**

Create `apps/desktop/src/folder-argv.ts`:

```ts
import path from 'node:path';

/**
 * `brainstrike <path>` and `second-instance` argv → absolute folder CANDIDATES
 * (BST-1393, spec §7 [D10]).
 *
 * CANDIDATES, emphatically: this function performs no I/O, asserts nothing
 * about the filesystem, and authorizes nothing. main stats each result to
 * confirm it is a directory, and the renderer routes it through
 * `fs:addRootByPath`, whose two gates decide whether it may be mounted at all
 * (ruling S1). argv is attacker-influencable — another process can launch this
 * app with any argument — so nothing downstream of here treats a candidate as
 * consent.
 *
 * The unpackaged skip mirrors Electron's own argv convention: `electron .`
 * puts the app directory at argv[1]. Without the skip, every dev launch would
 * ask to mount the repo.
 */
export interface FolderArgvParams {
  readonly argv: readonly string[];
  readonly isPackaged: boolean;
  readonly workingDirectory: string;
}

export function resolveFolderCandidatesFromArgv({
  argv,
  isPackaged,
  workingDirectory,
}: FolderArgvParams): readonly string[] {
  const positional = argv.slice(isPackaged ? 1 : 2);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of positional) {
    const value = raw.trim();
    if (value.length === 0 || value.startsWith('-')) {
      continue;
    }
    // `path.resolve` normalizes and strips a trailing separator, which is the
    // same key shape `normalizeRecentRootPath` uses, so `/w/repo` and
    // `/w/repo/` collapse to one candidate here as well as in the ledger.
    const resolved = path.resolve(workingDirectory, value);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(resolved);
  }
  return candidates;
}
```

- [ ] **Step 3: commit**

```bash
pnpm dlx ultracite fix apps/desktop/src/folder-argv.ts apps/desktop/src/__tests__/folder-argv.test.ts
git add -A && git commit -m "feat(BST-1393): pure argv folder-candidate parser

Candidates, not grants: no I/O, no authorization. Skips the app-path
argument on an unpackaged launch so \`electron .\` never asks to mount the
repo.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: the open-path queue

**Files:** `apps/desktop/src/workspace-open-queue.ts` (new), `apps/desktop/src/__tests__/workspace-open-queue.test.ts` (new)

macOS fires `open-file` BEFORE `whenReady`, and a first-launch argv path is known before any window exists. The queue is the honest answer: hold requests until a visible renderer says it has loaded, then deliver them; after that, deliver immediately.

- [ ] **Step 1 (RED)**

`apps/desktop/src/__tests__/workspace-open-queue.test.ts` covers:

- a request enqueued before `attachWindow` is delivered exactly once, in order, after it;
- a request enqueued after attach is delivered immediately;
- a destroyed `webContents` drops nothing on the floor — the request stays queued for the next attach;
- attaching a SECOND window does not re-deliver already-delivered requests;
- the queue is bounded (`MAX_PENDING_OPEN_REQUESTS`) and drops the OLDEST with a warn rather than growing without bound;
- `reset()` empties it (used by tests only).

- [ ] **Step 2 (GREEN)**

Create `apps/desktop/src/workspace-open-queue.ts`:

```ts
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('WorkspaceOpenQueue');

/**
 * Holds folder-open REQUESTS until a visible renderer can receive them
 * (BST-1393, spec §7 [D10]).
 *
 * Three producers fire before a renderer exists: macOS `open-file` (which
 * arrives before `whenReady`), first-launch argv, and a `second-instance`
 * whose window is still restoring. Delivering into a missing or unloaded
 * renderer would drop the user's request silently, which is exactly the
 * failure this queue exists to prevent.
 *
 * It is a DELIVERY buffer, never an authorization: each request is a path
 * string that the renderer still has to route through `fs:addRootByPath`.
 */
export interface WorkspaceOpenRequest {
  // Import the union rather than duplicating it: a fifth origin added to
  // WorkspaceOpenOrigin must not silently miss this queue's contract.
  readonly origin: WorkspaceOpenOrigin;
  readonly path: string;
}

/**
 * A launch cannot legitimately name more folders than this. The bound is
 * against a runaway producer (a `second-instance` storm), not against the
 * user; the OLDEST is dropped with a warn, because the newest request is the
 * one the user is looking at.
 */
export const MAX_PENDING_OPEN_REQUESTS = 16;

export interface WorkspaceOpenDeliveryTarget {
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: unknown) => void;
}

export function createWorkspaceOpenQueue(channel: string) {
  let target: WorkspaceOpenDeliveryTarget | null = null;
  const pending: WorkspaceOpenRequest[] = [];

  const flush = (): void => {
    if (!target || target.isDestroyed()) {
      return;
    }
    // Splice-then-send: a throwing `send` must not replay the whole queue on
    // the next flush, and the ordering the user typed is preserved.
    const draining = pending.splice(0, pending.length);
    for (const request of draining) {
      target.send(channel, request);
    }
  };

  return {
    /** The renderer has loaded and is listening. Idempotent. */
    attach(next: WorkspaceOpenDeliveryTarget): void {
      target = next;
      flush();
    },
    enqueue(request: WorkspaceOpenRequest): void {
      if (pending.length >= MAX_PENDING_OPEN_REQUESTS) {
        const dropped = pending.shift();
        logger.warn('Dropped the oldest pending folder-open request', {
          origin: dropped?.origin,
        });
      }
      pending.push(request);
      flush();
    },
    /** Test seam only. */
    reset(): void {
      pending.length = 0;
      target = null;
    },
  };
}

export type WorkspaceOpenQueue = ReturnType<typeof createWorkspaceOpenQueue>;
```

- [ ] **Step 3: commit** (`feat(BST-1393): buffer folder-open requests until a renderer is listening`)

---

## Task 10: main wires argv, `open-file` and `second-instance`

**Files:** `apps/desktop/src/main.ts`, `apps/desktop/src/__tests__/main/workspace-open-lifecycle.test.ts` (new)

- [ ] **Step 1 (GREEN): module-scope `open-file`**

macOS delivers `open-file` before `whenReady`, so the listener MUST be registered at module scope. It goes inside the existing `if (singleInstanceLockAcquired) { … }` block, above `app.whenReady()`:

```ts
  const workspaceOpenQueue = createWorkspaceOpenQueue(DESKTOP_IPC_CHANNELS.workspace.openPath);

  // macOS delivers this before `whenReady` (Dock drop, "Open With", a click in
  // the Dock's recent-documents list that `app.addRecentDocument` populates),
  // so the listener is registered at module scope and the queue holds the
  // request until a renderer is listening. Registered in E2E mode too — the
  // desktop e2e drives it with `app.emit('open-file', …)`, which is the only
  // way this entry point is observable end to end.
  app.on('open-file', (event, openedPath) => {
    event.preventDefault();
    workspaceOpenQueue.enqueue({ origin: 'open-file', path: openedPath });
  });
```

- [ ] **Step 2 (GREEN): `second-instance` argv**

Change the existing listener's signature from a no-arg closure to `(_event, argv: string[], workingDirectory: string)`. Enqueue BEFORE the existing show/focus body so the request is queued even if the window lookup finds nothing:

```ts
    app.on('second-instance', (_event, secondInstanceArgv, workingDirectory) => {
      for (const candidate of resolveFolderCandidatesFromArgv({
        argv: secondInstanceArgv,
        isPackaged: app.isPackaged,
        workingDirectory,
      })) {
        workspaceOpenQueue.enqueue({ origin: 'second-instance', path: candidate });
      }
      // …the existing show + focus body, unchanged…
    });
```

> **Honest coverage note (ruling L3):** this listener is registered only `if (!e2eTestMode)`, and E2E cannot launch a second process against the harness's app. Its parse is covered by Task 8 and its delivery path is the same queue + channel the `open-file` E2E exercises end to end. No E2E is invented for it.

- [ ] **Step 3 (GREEN): first-launch argv + delivery**

Inside `whenReady`, after `createMainWindow()` resolves, enqueue the launch argv and attach the window:

```ts
      for (const candidate of resolveFolderCandidatesFromArgv({
        argv: process.argv,
        isPackaged: app.isPackaged,
        workingDirectory: process.cwd(),
      })) {
        workspaceOpenQueue.enqueue({ origin: 'argv', path: candidate });
      }

      // `did-finish-load` is the renderer-is-listening signal: the preload has
      // run and React has mounted `WorkspaceConnectHost`'s subscriptions by the
      // time it fires. Attaching on `ready-to-show` would deliver into a
      // renderer with no listener and lose the request in silence.
      mainWindow.webContents.on('did-finish-load', () => {
        workspaceOpenQueue.attach({
          isDestroyed: () => mainWindow.webContents.isDestroyed(),
          send: (channel, payload) => {
            mainWindow.webContents.send(channel, payload);
          },
        });
      });
```

> **Verify at execution, do not assume:** `did-finish-load` fires again on every reload, and `attach` is idempotent by construction (it only re-points the target and flushes an empty queue). Confirm the local identifier for the created window in `main.ts` (`rg -n "createMainWindow" apps/desktop/src/main.ts`) rather than assuming `mainWindow`.

**Deliberately NOT filtered in main:** a candidate is not `stat`ed here. `addRootByPath`'s `createSecureRoot` probe already realpaths and validates, and its failure reaches the user through the same toast — a second, earlier check in main would either duplicate that or, worse, disagree with it. What main DOES guarantee is that the path is absolute and non-empty (Task 8) so the renderer's narrowing has something well-formed to accept.

- [ ] **Step 4 (RED→GREEN): the lifecycle test**

`apps/desktop/src/__tests__/main/workspace-open-lifecycle.test.ts`, using the Flavor-A inline electron mock from `boot-order.test.ts` (read it at HEAD and copy the `mockApp` / `mockBrowserWindow` shape; note the Vitest-4 constructor-mock comment it carries). Assertions:

- importing `../../main` registers an `open-file` listener (`mockApp.on` called with `'open-file'`);
- emitting `open-file` before any window, then firing the captured `did-finish-load`, sends exactly one `workspace:open-path` with `{ origin: 'open-file', path }`;
- the `second-instance` listener is registered with a handler that accepts argv (assert arity ≥ 3 rather than behavior, which needs the non-e2e branch);
- a launch argv folder is enqueued once and delivered once.

- [ ] **Step 5 (VERIFY + commit)**

```bash
pnpm run type-check
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/main src/__tests__/folder-argv.test.ts src/__tests__/workspace-open-queue.test.ts
pnpm dlx ultracite fix apps/desktop/src/main.ts
```

```bash
git add -A && git commit -m "feat(BST-1393): open a folder from argv, open-file and second-instance

open-file registers at module scope because macOS fires it before ready;
every producer enqueues and the queue delivers on did-finish-load, so a
request made before a renderer exists is held rather than dropped.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Layer 4 — drag a folder from Finder onto the composer

## Task 11: the pure dropped-folder extractor

**Files:** `packages/app-shell/src/workspace-connect/extract-dropped-folder-paths.ts` (new), `packages/app-shell/src/__tests__/extract-dropped-folder-paths.test.ts` (new)

- [ ] **Step 1 (RED)**

Create `packages/app-shell/src/__tests__/extract-dropped-folder-paths.test.ts`. The harness deliberately mirrors `packages/notes-vault/src/core/__tests__/drop.test.ts`: each fake item becomes unusable after one microtask, so a lazy implementation fails.

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  type DroppableFolderItem,
  extractDroppedFolderPaths,
} from '../workspace-connect/extract-dropped-folder-paths';

function directoryItem(path: string): DroppableFolderItem {
  let settled = false;
  queueMicrotask(() => {
    settled = true;
  });
  const file = { name: path.split('/').at(-1) ?? path } as unknown as File;
  return {
    getAsFile: () => {
      if (settled) {
        throw new Error('DataTransferItem accessed after the drop event settled');
      }
      return file;
    },
    kind: 'file',
    webkitGetAsEntry: () => {
      if (settled) {
        throw new Error('DataTransferItem accessed after the drop event settled');
      }
      return { isDirectory: true };
    },
  };
}

function plainFileItem(): DroppableFolderItem {
  return {
    getAsFile: () => ({ name: 'notes.md' }) as unknown as File,
    kind: 'file',
    webkitGetAsEntry: () => ({ isDirectory: false }),
  };
}

describe('extractDroppedFolderPaths', () => {
  it('resolves every dropped directory inside the drop tick', () => {
    const resolvePath = vi.fn((file: File) => `/w/${file.name}`);
    expect(
      extractDroppedFolderPaths([directoryItem('/w/alpha'), directoryItem('/w/beta')], resolvePath)
    ).toEqual({ paths: ['/w/alpha', '/w/beta'], skippedFileCount: 0, unresolvedCount: 0 });
    expect(resolvePath).toHaveBeenCalledTimes(2);
  });

  it('COUNTS plain files instead of forwarding them', () => {
    // Ruling D1's falsifier: a blind-send implementation would hand a FILE to
    // fs:addRootByPath, which refuses it with a message about GRANTS —
    // describing the wrong problem entirely.
    const resolvePath = vi.fn(() => '/w/notes.md');
    expect(extractDroppedFolderPaths([plainFileItem()], resolvePath)).toEqual({
      paths: [],
      skippedFileCount: 1,
      unresolvedCount: 0,
    });
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it('counts a directory whose File is not disk-backed rather than dropping it silently', () => {
    expect(extractDroppedFolderPaths([directoryItem('/w/alpha')], () => '')).toEqual({
      paths: [],
      skippedFileCount: 0,
      unresolvedCount: 1,
    });
  });

  it('ignores non-file items (a dragged text selection)', () => {
    expect(
      extractDroppedFolderPaths(
        [{ getAsFile: () => null, kind: 'string', webkitGetAsEntry: () => null }],
        vi.fn()
      )
    ).toEqual({ paths: [], skippedFileCount: 0, unresolvedCount: 0 });
  });

  it('survives an item whose entry cannot be read', () => {
    const throwing: DroppableFolderItem = {
      getAsFile: () => null,
      kind: 'file',
      webkitGetAsEntry: () => {
        throw new Error('no entry');
      },
    };
    expect(
      extractDroppedFolderPaths([throwing, directoryItem('/w/alpha')], (file) => `/w/${file.name}`)
    ).toEqual({ paths: ['/w/alpha'], skippedFileCount: 0, unresolvedCount: 1 });
  });

  it('dedupes a folder dropped twice in one gesture', () => {
    expect(
      extractDroppedFolderPaths([directoryItem('/w/alpha'), directoryItem('/w/alpha')], () => '/w/alpha')
    ).toEqual({ paths: ['/w/alpha'], skippedFileCount: 0, unresolvedCount: 0 });
  });
});
```

- [ ] **Step 2 (GREEN)**

Create `packages/app-shell/src/workspace-connect/extract-dropped-folder-paths.ts`:

```ts
/**
 * A Finder folder drop → absolute paths to REQUEST (BST-1393, spec §4.1
 * [D7]).
 *
 * Everything here is SYNCHRONOUS, on purpose. A `DataTransferItem` is invalid
 * the moment the drop event settles, so both `webkitGetAsEntry()` and
 * `getAsFile()` must be called inside the drop tick — the contract
 * `packages/notes-vault/src/core/drop.ts` established and whose test proves by
 * invalidating the item after one microtask. This module needs no `await` at
 * all: unlike the vault's FSA path, `getPathForFile` is synchronous.
 *
 * Files vs folders are told apart by ASKING the DOM (`entry.isDirectory`),
 * never by guessing from `size`/`type` and never by forwarding everything to
 * main (ruling D1): a plain file sent to `fs:addRootByPath` comes back with a
 * message about GRANTS, which misdescribes the problem.
 *
 * Both non-outcomes are COUNTED, not swallowed: the caller states them.
 */
export interface DroppableFolderItem {
  readonly getAsFile: () => File | null;
  readonly kind: string;
  readonly webkitGetAsEntry: () => { readonly isDirectory: boolean } | null;
}

export interface DroppedFolderPaths {
  /** Absolute, deduped, in drop order. */
  readonly paths: readonly string[];
  /** Dropped items that were plain files. */
  readonly skippedFileCount: number;
  /** Directories whose `File` yielded no path (not disk-backed, or unreadable). */
  readonly unresolvedCount: number;
}

export function extractDroppedFolderPaths(
  items: Iterable<DroppableFolderItem>,
  resolvePath: (file: File) => string
): DroppedFolderPaths {
  const seen = new Set<string>();
  const paths: string[] = [];
  let skippedFileCount = 0;
  let unresolvedCount = 0;

  for (const item of items) {
    if (item.kind !== 'file') {
      continue;
    }
    let isDirectory = false;
    let file: File | null = null;
    try {
      isDirectory = item.webkitGetAsEntry()?.isDirectory === true;
      file = isDirectory ? item.getAsFile() : null;
    } catch {
      // The item became unusable (or the browser refused it). Counted, so the
      // notice can say "1 item could not be read" instead of nothing.
      unresolvedCount += 1;
      continue;
    }
    if (!isDirectory) {
      skippedFileCount += 1;
      continue;
    }
    const resolved = file ? resolvePath(file) : '';
    if (resolved.length === 0) {
      unresolvedCount += 1;
      continue;
    }
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    paths.push(resolved);
  }

  return { paths, skippedFileCount, unresolvedCount };
}
```

- [ ] **Step 3: commit** (`feat(BST-1393): pure dropped-folder path extraction`)

---

## Task 12: the composer drop zone

**Files:** `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx`, `packages/assistant-ui/src/workspace-bar/workspace-bar-drop-zone.tsx` (new), `packages/app-shell/src/workspace-connect/use-folder-drop.ts` (new), `packages/app-shell/src/hooks/use-workspace-bar.ts`, `packages/assistant-ui/src/__tests__/workspace-bar-drop.test.tsx` (new), `packages/app-shell/src/__tests__/use-folder-drop.test.tsx` (new)

**Interface this task lands:**

```ts
// packages/assistant-ui/src/workspace-bar/workspace-bar.tsx
export interface WorkspaceBarProps {
  // …unchanged members
  /**
   * Receives the drop's `DataTransferItem`s. Present only when the platform
   * can resolve a dropped folder to a path (desktop). Path resolution and
   * mounting live in app-shell; this package stays store-free and
   * Electron-free.
   */
  readonly onDropItems?: ((items: readonly DataTransferItem[]) => void) | undefined;
}
```

> **Biome contingency (pre-authorized, BOTH rules):** if adding the zone fires `noExcessiveLinesPerFile` or `noExcessiveCognitiveComplexity` on `workspace-bar.tsx` (267 physical lines today — unlikely) or on `use-workspace-bar.ts` (1044 physical, ~749 code — the realistic one, and cognitive complexity is the likelier of the two because the wiring adds a capability conditional to an already dense hook), the zone lives in `workspace-bar-drop-zone.tsx` (already in the Files list) and the app-shell wiring lives in `use-folder-drop.ts` returning a ready-to-spread partial — the `use-workspace-bar-terminal.ts` idiom, which exists for exactly this pressure.

- [ ] **Step 1 (RED): the pure surface**

Create `packages/assistant-ui/src/__tests__/workspace-bar-drop.test.tsx`:

```tsx
  function dataTransfer(types: readonly string[], items: readonly unknown[] = []) {
    return { items, types };
  }

  it('arms the drop ring only for a drag that carries files', () => {
    render(<WorkspaceBar {...baseProps} onDropItems={onDropItems} />);
    const zone = screen.getByTestId('workspace-bar-drop-zone');
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer(['text/plain']) });
    expect(zone.className).not.toContain('ring-2');
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer(['Files']) });
    expect(zone.className).toContain('ring-2');
  });

  it('hands the drop items straight through, exactly once', () => {
    const items = [{ kind: 'file' }];
    render(<WorkspaceBar {...baseProps} onDropItems={onDropItems} />);
    fireEvent.drop(screen.getByTestId('workspace-bar-drop-zone'), {
      dataTransfer: dataTransfer(['Files'], items),
    });
    expect(onDropItems).toHaveBeenCalledExactlyOnceWith(items);
  });

  it('ignores a drop with no files and never calls the handler', () => {
    render(<WorkspaceBar {...baseProps} onDropItems={onDropItems} />);
    fireEvent.drop(screen.getByTestId('workspace-bar-drop-zone'), {
      dataTransfer: dataTransfer(['text/plain'], [{ kind: 'string' }]),
    });
    expect(onDropItems).not.toHaveBeenCalled();
  });

  it('renders NO drop affordance without the handler (web)', () => {
    // Capability gating by omission: the ring, the listeners and the testid
    // are all absent — not a disabled zone.
    render(<WorkspaceBar {...baseProps} />);
    expect(screen.queryByTestId('workspace-bar-drop-zone')).not.toBeInTheDocument();
  });

  it('clears the ring on dragleave from the zone itself, not from a child chip', () => {
    // Prevents the flicker the vault panel's `currentTarget === target` guard
    // exists to avoid: the bar is full of chips.
    const zone = screen.getByTestId('workspace-bar-drop-zone');
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer(['Files']) });
    fireEvent.dragLeave(zone, { relatedTarget: zone.firstElementChild });
    expect(zone.className).toContain('ring-2');
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toContain('ring-2');
  });
```

- [ ] **Step 2 (GREEN): the zone**

Create `packages/assistant-ui/src/workspace-bar/workspace-bar-drop-zone.tsx` holding the ring state and the three handlers, and have `WorkspaceBar` render its existing `<div data-testid="workspace-bar">` children inside it when `onDropItems` is supplied (and render them bare otherwise — no wrapper, no zone, on web). The `Files` gate is `Array.from(event.dataTransfer?.types ?? []).includes('Files')`, checked BEFORE `preventDefault()` so an internal pragmatic-drag-and-drop thread-tab drag passes through untouched — the exact discipline `notes-vault-panel.tsx`'s `dragCarriesFiles` uses, and the reason the two drag systems coexist today.

- [ ] **Step 3 (GREEN): app-shell wiring**

Create `packages/app-shell/src/workspace-connect/use-folder-drop.ts`:

```ts
/**
 * The workspace bar's folder-drop wiring (BST-1393, spec §4.1 [D7]), pulled
 * out of `use-workspace-bar.ts` for the same reason
 * `use-workspace-bar-terminal.ts` was: it owns a capability memo plus a stable
 * callback, and folding it into that hook would push its cognitive complexity
 * against Biome's ceiling.
 *
 * Returns a ready-to-spread partial, so the call site carries no conditional
 * of its own — the capability gate is pulled out entirely rather than merely
 * relocated.
 */
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import { useCallback, useMemo } from 'react';
import { extractDroppedFolderPaths } from './extract-dropped-folder-paths';
import { useConnectFolder } from './use-connect-folder';
import { resolveWorkspaceConnectBridge } from './workspace-connect-bridge';

const logger = createLogger('FolderDrop');

export function useFolderDrop(): {
  readonly onDropItems?: ((items: readonly DataTransferItem[]) => void) | undefined;
} {
  // Resolved ONCE per hook instance, not per render: the capability IS the
  // gate, so web renders no drop zone rather than a zone that refuses.
  const bridge = useMemo(() => resolveWorkspaceConnectBridge(), []);
  const { connectPath } = useConnectFolder();
  const onDropItems = useCallback(
    (items: readonly DataTransferItem[]) => {
      if (!(bridge && connectPath)) {
        return;
      }
      const { paths, skippedFileCount, unresolvedCount } = extractDroppedFolderPaths(
        items,
        bridge.getDroppedPath
      );
      for (const droppedPath of paths) {
        // 'drop' is a first-class WorkspaceOpenOrigin (coordinator ruling,
        // via-vocabulary lesson): the refusal log's `origin` field is the
        // diagnostic someone reads when asking how a folder got here, and a
        // breadcrumb must name its real gesture even though a drop never
        // crosses IPC as an open-path push.
        void connectPath({ origin: 'drop', path: droppedPath });
      }
      // Both non-outcomes are stated. A drop that mounted nothing and said
      // nothing is the silent failure this whole feature must not have.
      if (skippedFileCount > 0 || unresolvedCount > 0) {
        logger.info('Dropped items were not folders', { skippedFileCount, unresolvedCount });
        toast({
          description: [
            skippedFileCount > 0
              ? `${skippedFileCount} dropped item${skippedFileCount === 1 ? ' is a file' : 's are files'}, not folders.`
              : null,
            unresolvedCount > 0
              ? `${unresolvedCount} dropped folder${unresolvedCount === 1 ? '' : 's'} could not be read from disk.`
              : null,
          ]
            .filter((line) => line !== null)
            .join(' '),
          title: paths.length > 0 ? 'Some dropped items were skipped' : 'Nothing to connect',
          variant: 'destructive',
        });
      }
    },
    [bridge, connectPath]
  );
  return bridge && connectPath ? { onDropItems } : {};
}
```

> **(Ruled at plan review: the fifth origin is IN.)** `'drop'` is a first-class member of `WorkspaceOpenOrigin` and `WORKSPACE_OPEN_ORIGINS` (both edited above), and `WorkspaceOpenRequest` imports the union instead of duplicating it. Task 5's narrowing test is the census: extend its accepted-origins fixture to include `'drop'` alongside the wire origins.

In `packages/app-shell/src/hooks/use-workspace-bar.ts`, import `useFolderDrop` and spread its result into the returned props object beside the existing `...(addRootDirectoryByPath ? { onAddRecent } : {})` line:

```ts
  const folderDropEntry = useFolderDrop();
```

```ts
    ...folderDropEntry,
```

- [ ] **Step 4 (RED→GREEN): the wiring test**

`packages/app-shell/src/__tests__/use-folder-drop.test.tsx`, with `vi.hoisted` mocks for `resolveWorkspaceConnectBridge`, `useConnectFolder` and `toast`: (a) two dropped folders call `connectPath` twice with the exact paths and toast zero times; (b) a mixed drop mounts the folder AND toasts the skip notice once; (c) an all-files drop calls `connectPath` zero times and toasts "Nothing to connect"; (d) no bridge ⇒ `onDropItems` is `undefined`; (e) a bridge but no `connectPath` ⇒ `onDropItems` is `undefined`.

- [ ] **Step 5 (VERIFY + commit)**

```bash
pnpm run type-check
pnpm --filter @brainstrike/assistant-ui test
pnpm --filter @brainstrike/app-shell test
pnpm exec biome check packages/app-shell/src/hooks/use-workspace-bar.ts packages/assistant-ui/src/workspace-bar/workspace-bar.tsx
pnpm dlx ultracite fix packages/assistant-ui/src/workspace-bar packages/app-shell/src/workspace-connect packages/app-shell/src/hooks/use-workspace-bar.ts
npx react-doctor . --scope changed --base <task-11-sha> --verbose -y
```

```bash
git add -A && git commit -m "feat(BST-1393): drop a Finder folder onto the composer to connect it

The bar owns the Files gate and the ring; app-shell owns path resolution and
mounting. Directories are told apart by asking the DOM, and skipped items are
counted and stated rather than swallowed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Layer 5 — verification and living docs

## What is actually testable, at which layer (read before Task 13)

No coverage is invented here. This table is the honest answer to "prove it works":

| Behaviour | Unit | Desktop E2E | CDT | Why not lower/higher |
| --- | --- | --- | --- | --- |
| `workspace-root` target adapter, both action sets | ✅ Tasks 1–4 | — | — | Pure. |
| Root-header menu opens with the right items | ✅ Task 3 (jsdom + Radix) | ✅ Task 13 | ✅ Task 14 | The jsdom test proves composition; e2e proves it against the real registry and real roots. |
| **Open in Terminal from a root header lands a shell at that root** | ✅ Task 4 (seam call) | ✅ Task 13 (`pwd`) | — | A seam-call assertion passes on a wrong-cwd implementation; only `pwd` inside the spawned shell falsifies it. |
| `window.workspace` exact key set | ✅ Task 5 (contract test) | — | — | The preload AST is the authority. |
| Never-granted refusal + "Add folder…" remedy | ✅ Task 6 | ✅ Task 13 | ✅ Task 14 | e2e drives it with a real un-granted temp dir through the real main gates. |
| File ▸ Open Folder… routes to the renderer | ✅ Task 7 (template) | ✅ Task 13 (`getMenuItemById(...).click()` in main, assert the renderer received it) | — | The application menu is unreachable from Playwright's page context; driving it from `electronApp.evaluate` is the real path. The NATIVE picker it opens cannot be dismissed by Playwright, so the e2e stops at "the renderer was asked", which is exactly the contract Task 7 owns. |
| File ▸ Open Recent projection | ✅ Task 7 | ✅ Task 13 (inspect `Menu.getApplicationMenu()` in main after seeding the ledger) | — | No dialog involved — fully assertable. |
| **macOS `open-file` end to end** | ✅ Task 10 | ✅ Task 13 (`app.emit('open-file', …)` from main, assert the root mounts) | — | Emitting on the `app` object drives the real listener, the real queue, the real channel and the real renderer seam. |
| `brainstrike <path>` argv parse | ✅ Task 8 | ❌ | — | The harness launches the app with fixed arguments; a second launch with a folder argument is not something the desktop fixture supports. Its DELIVERY path is the same queue + channel the `open-file` e2e proves end to end. |
| `second-instance` argv | ✅ Task 8 (parse) | ❌ **structurally** | — | `main.ts` registers the listener only `if (!e2eTestMode)`, and e2e cannot launch a competing process against the harness app. Stated, not papered over (ruling L3). |
| Drag-drop: `Files` gate, ring, handoff | ✅ Task 12 | ⚠️ partial (Task 13 dispatches a synthetic `DragEvent`; `getPathForFile` returns `''` for a JS-constructed `File`, so the e2e can prove the GATE and the skip notice, never a real path) | ✅ Task 14 (computed ring) | Playwright cannot synthesize an OS file drag carrying a real `webkitGetAsEntry()` directory. Claiming otherwise would be the invented coverage this plan refuses. |
| Drag-drop: a real Finder folder mounting | ❌ | ❌ | ✅ **manual, in Task 14, recorded with the resulting root id** | The one behaviour with no automated proof. It is named in the definition of done as a manual step with a recorded result, not silently assumed. |

## Task 13: desktop E2E

**Files:** `apps/desktop/e2e/add-root-ui.smoke.desktop.test.ts`, `apps/desktop/e2e/workspace-bar.desktop.test.ts`

Both files are ALREADY in `apps/desktop/package.json`'s `test:e2e:lane:smoke` list — **no lane registration is needed, and none may be added.** Read each at HEAD for its `freshRepo` / `createTempDirTracker` / `seedRoot` / `setupAssistantMock` / `startModelProviderShim` harness before writing; reuse, do not re-derive.

- [ ] **Step 1: root-header menu + Open in Terminal (`add-root-ui.smoke.desktop.test.ts`)**

```ts
  test('the root header offers workspace-root actions and opens a shell at that root @smoke', async () => {
    const repo = await freshRepo(tempDirs);
    await seedRoot(window, repo, {
      disableBackgroundIndexing: true,
      reloadReason: 'BST-1393 root context menu',
      rootId: 'root-bst-1393',
    });

    await window.getByTestId('root-section-header-row').first().click({ button: 'right' });
    // Set as Main is absent on the ONLY root, which is already Main — the
    // isVisible gate, proven against the real registry rather than a mock.
    await expect(window.getByRole('menuitem', { name: 'Set as Main' })).toHaveCount(0);
    await expect(window.getByRole('menuitem', { name: 'Copy Path' })).toBeVisible();
    await expect(window.getByRole('menuitem', { name: /^Reveal in / })).toBeVisible();
    await expect(window.getByRole('menuitem', { name: 'New Thread Here' })).toBeVisible();

    await window.getByRole('menuitem', { name: 'Open in Terminal' }).click();
    await waitForShellReady(window);
    // The falsifier a header-label-only implementation fails: what the shell
    // reports, not what the panel says.
    await window.keyboard.type('pwd\n');
    await expect
      .poll(async () => (await readTerminalBuffer(window)).includes(await realpath(repo)))
      .toBe(true);
  });

  test('Disconnect… stages the confirmation and removes nothing until confirmed @smoke', async () => {
    await window.getByTestId('root-section-header-row').first().click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Disconnect…' }).click();
    await expect(window.getByRole('dialog')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('root-section-header-row')).toHaveCount(1);
  });
```

> Read `apps/desktop/e2e/terminal-panel.desktop.test.ts` at HEAD for the real names of `waitForShellReady` / the buffer reader and use those verbatim; the two helper names above are placeholders for whatever that file already exports.

- [ ] **Step 2: File menu, driven from main (`add-root-ui.smoke.desktop.test.ts`)**

```ts
  test('File ▸ Open Recent lists a granted folder and File ▸ Open Folder asks the renderer @smoke', async () => {
    const repo = await freshRepo(tempDirs);
    await seedRoot(window, repo, {
      recentPaths: [repo],
      reloadReason: 'BST-1393 file menu',
      rootId: 'root-file-menu',
    });

    const recentLabels = await electronApp.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('file-open-recent');
      return (item?.submenu?.items ?? []).map((entry) => entry.label);
    });
    expect(recentLabels).toContain(path.basename(repo));
    expect(recentLabels.at(-1)).toBe('Clear Menu');

    // Open Folder… opens a NATIVE picker that Playwright cannot dismiss, so
    // the assertion stops exactly where this feature's contract does: the
    // focused renderer was asked to run its own picker flow.
    const asked = window.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const bridge = (globalThis as { workspace?: { onOpenFolderPicker?: (cb: () => void) => () => void } })
            .workspace;
          if (!bridge?.onOpenFolderPicker) {
            resolve(false);
            return;
          }
          const off = bridge.onOpenFolderPicker(() => {
            off();
            resolve(true);
          });
        })
    );
    await electronApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('file-open-folder')?.click();
    });
    expect(await asked).toBe(true);
  });
```

- [ ] **Step 3: `open-file` end to end, both outcomes (`add-root-ui.smoke.desktop.test.ts`)**

```ts
  test('an open-file event mounts a previously granted folder @smoke', async () => {
    const granted = await freshRootDir(tempDirs);
    await seedRoot(window, firstRepo, {
      recentPaths: [granted],
      reloadReason: 'BST-1393 open-file grant',
      rootId: 'root-open-file',
    });

    await electronApp.evaluate(({ app }, openedPath) => {
      app.emit('open-file', { preventDefault() {} }, openedPath);
    }, granted);

    await expect(
      window.getByTestId('root-section-header').filter({ hasText: path.basename(granted) })
    ).toBeVisible();
  });

  test('an open-file event for a NEVER-granted folder refuses and offers the picker @smoke', async () => {
    // The security ruling (S1), proven end to end through the real main gates:
    // another process can trigger open-file, so a path we have never been
    // granted must not mount.
    const stranger = await freshRootDir(tempDirs);
    await electronApp.evaluate(({ app }, openedPath) => {
      app.emit('open-file', { preventDefault() {} }, openedPath);
    }, stranger);

    await expect(window.getByTestId('workspace-connect-grant-action')).toBeVisible();
    await expect(
      window.getByTestId('root-section-header').filter({ hasText: path.basename(stranger) })
    ).toHaveCount(0);
  });
```

- [ ] **Step 4: the drop gate (`workspace-bar.desktop.test.ts`)**

```ts
  test('the composer drop zone ignores a drag that carries no files @smoke', async () => {
    const zone = window.getByTestId('workspace-bar-drop-zone');
    await expect(zone).toBeVisible();
    await zone.dispatchEvent('dragover', { dataTransfer: { items: [], types: ['text/plain'] } });
    await expect(zone).not.toHaveClass(/ring-2/);
    await zone.dispatchEvent('dragover', { dataTransfer: { items: [], types: ['Files'] } });
    await expect(zone).toHaveClass(/ring-2/);
  });
```

> **State in the PR body, do not skip:** this proves the gate and the ring only. A synthetic `DragEvent` carries no OS-backed `File`, so `getPathForFile` returns `''` and no path is ever resolved. The real-folder drop is the manual CDT step in Task 14.

- [ ] **Step 5: run the lane**

```bash
pnpm --filter @brainstrike/desktop run build
pnpm --filter @brainstrike/desktop run test:e2e:lane:smoke
```

- [ ] **Step 6: commit** (`test(BST-1393): desktop e2e for the root menu, File menu and open-file`)

---

## Task 14: CDT verification and living docs

**Files:** `docs/agents/workspace-context.md`, `docs/agents/ui-conventions.md`

- [ ] **Step 1: live CDT verification (definition of done for UI work)**

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug   # BRAINSTRIKE_AGENT_DEVTOOLS=1, port 9222
```

Attach and report **computed values**, not impressions. Minimum evidence for the PR body:

1. Right-click a root header → the menu's `role="menu"` item labels, in order, plus each item's `aria-disabled`. Expect the Set-as-Main row absent on the Main root and present on a second root.
2. `getBoundingClientRect()` of the open menu against the header row — the menu must not paint under the floating tree-actions cluster (`RootSectionHeader`'s `reserveFloatingActionsClearance` exists because that band is contested).
3. `getComputedStyle` of the composer drop zone before and during a `dragover` carrying `Files` — report the actual `box-shadow`/ring values in BOTH themes (`prefers-color-scheme` light and dark).
4. The refusal toast: its rendered `title`, `description` and the action button's accessible name, captured from a real never-granted `open-file`.
5. **The one manual step: drag a real folder from Finder onto the composer.** Record the resulting root id and the mounted path, or the refusal toast if the folder was never granted. This is the single behaviour with no automated proof (see the coverage table) — record the outcome, do not assert it from the code.
6. **(Added during PR #2676 review) Disconnect… dialog-focus ordering.** `ActionContextMenu`'s `onCloseAutoFocus` skips its own focus restoration while `isDisconnectDialogOpen` is true (both `RootSectionInner` and the single-root layout's `useSingleRootHeaderMenu`), specifically to avoid a possible race: `ContextMenuContent` exits via `data-[state=closed]:animate-out`, so under Radix `Presence` the real unmount — and `onCloseAutoFocus` — can fire AFTER `DisconnectRootDialog` has already mounted and autofocused. jsdom has no animation (synchronous unmount), so no unit test can observe this ordering; the guard is a defensive skip, not a confirmed fix. Right-click a root header (forest AND single-root), choose Disconnect…, and confirm the dialog keeps focus with no visible flicker to the header toggle button. Report what you observed, not just that the dialog opened.

Paste the computed values and screenshots into the PR.

- [x] **Step 2: `docs/agents/workspace-context.md`** — **LANDED EARLY** during PR #2676 review (a P1 finding: the DEFERRED bullet still contradicted shipped behavior after Task 3/4 merged). The replacement text below reflects the ORIGINAL plan draft; the actual landed text also covers the single-root fold-in (Task 1 above) and the Set-as-Main/Disconnect gating fixes, so it differs from this draft — read the live doc rather than reapplying this block verbatim. `docs/agents/ui-conventions.md`'s CONTEXT ACTION SYSTEM section also gained a paired bullet (the "target kind with more than one trigger surface" pattern) — verify it's still current rather than adding a second one.

Replace the DEFERRED bullet:

```md
- DEFERRED (v1 ruling): a root-header right-click context action ("Set as
  main" / Disconnect / Copy path / Reveal) — root headers have no
  ContextTarget kind yet; it is a coherent follow-up surface.
```

with:

```md
- **Root-header context menu (BST-1393, spec §7)** — the deferral above is
  CLOSED. `packages/context-actions/src/types.ts` now carries a
  `workspace-root` kind (`displayName` · `isMain` · `path | null` · `rootId`),
  adapted from a section header by `workspaceRootToTarget`
  (`packages/file-explorer-ui/src/context-actions/workspace-root-target.ts`),
  which normalizes a web FSA handle's name-as-path to `null` so path-shaped
  actions hide by DATA rather than by platform. `RootSection` wraps ONLY the
  header in `ActionContextMenu` — never the tree pane, which owns its own —
  so the two menus stay siblings rather than nesting.
  - Six items, three owners. GLOBAL registry: `workspace-root.copy-path`
    (`clipboard`) and `workspace-root.reveal` (`fs.reveal`). SURFACE-LOCAL in
    `file-explorer-ui`: `workspace-root.set-as-main` and a STAGED
    `workspace-root.disconnect` (the run opens `DisconnectRootDialog`; the
    dialog's confirm removes). INJECTED by app-shell through
    `FileExplorerPanel`'s `rootActions` prop (the `selectionActions`
    precedent): `workspace-root.open-in-terminal` (the BST-1457
    `terminal-target-store` seam — a mounted root IS its own cwd, so `cwd`
    and `rootId` name the same folder here) and
    `workspace-root.new-thread-here`.
  - **"Set as Main", not "Make primary" (BST-1393 ruling R1).** This surface
    changes the workspace-wide MAIN root (`setMainRoot`, `activeRootIds[0]`) —
    the role this same header already renders as its "Main" badge. The
    workspace bar's "Make primary" is a DIFFERENT operation with a different
    writer (the thread's `operatingRoot*` metadata triple) and is untouched.
    Do not merge the two vocabularies.
  - "New thread here" goes through `useCreateThreadInFolder`
    (`packages/app-shell/src/hooks/use-create-thread-in-folder.tsx`), which is
    the threads panel's own folder-bound creation extracted so BOTH surfaces
    keep ONE writer of the `operatingRoot*` triple: one `createThread`, then
    ONE metadata write (the repository rejects a partial triple).

**Low-friction folder connection (BST-1393, spec §7 [D7] [D10]).** Five
gestures now ask this app to connect a folder: File ▸ Open Folder… (⌘O),
File ▸ Open Recent, `brainstrike <path>` / `second-instance` argv, macOS
`open-file` (which is also what a click in the Dock's recent-documents list
delivers, since grants call `app.addRecentDocument`), and a Finder folder
dropped on the composer's workspace bar. **All five converge on ONE renderer
seam** — `useConnectFolder`
(`packages/app-shell/src/workspace-connect/use-connect-folder.tsx`) — and that
seam calls the EXISTING picker-less `fs:addRootByPath`. **W6 added no third
authorization.** The two gates documented above are still the only ones.

- **A path from any of these is a REQUEST, never a grant.** `open-file` and
  argv are attacker-influencable — another process can run
  `open -a BrainStrike <path>` — and a mounted root is read access for the
  agent, so nothing in this path calls `recordRecentRoot`. A never-granted
  path surfaces the main-side refusal as a PERSISTENT destructive toast that
  names the folder and carries an "Add folder…" action opening the real OS
  picker (`data-testid="workspace-connect-grant-action"`). The renderer
  branches on exactly one boundary — granted vs not — by matching the two
  literal refusal strings; anything else degrades to the raw error text and
  no remedy, which is [D9]'s "Folder not found" case. It never degrades to a
  WRONG remedy.
- This costs almost nothing in practice: `RECENT_ROOTS_LIMIT` is 50 and a
  disconnect does not revoke a grant, so `brainstrike .` in any repo you have
  ever opened just works. Only a genuinely new folder costs one confirmation.
- Main→renderer over `window.workspace` (`workspace:open-folder-picker`,
  `workspace:open-path`), whose third member `getDroppedPath` is a
  preload-local `webUtils.getPathForFile`. A new bridge rather than a fourth
  `window.platform` member: that bridge's exact-set pin is duck-typed by four
  fixtures in `context-action-registry.test.ts`, which a new required member
  would silently invalidate.
- **Open Folder… does not open a dialog in main.** It pushes to the FOCUSED
  window and the renderer runs the SAME `addRootDirectory()` the Folder chip's
  "Add folder…" runs, so the grant recording, the recents refresh and the
  reconciliation nudge stay on one path.
- **File ▸ Open Recent projects main's own ledger**, capped at 10 rows
  (`FILE_MENU_RECENT_LIMIT` — the ledger's 50 is storage hygiene, not a menu
  bound), newest-first, labelled by basename with the full path as the
  tooltip, and DISABLED (not hidden) when empty. It rebuilds on a coalesced
  250 ms schedule whenever `registerFileSystemIpcHandlers`'
  `onWorkspaceRootGranted` fires. **"Clear Menu" clears only
  `app.clearRecentDocuments()`** — never `recentRootsList`, because that
  ledger is what authorizes a picker-less mount and clearing it from a menu
  item labelled "Clear Menu" would silently revoke grants. Emptying the app
  ledger is "Remove from recents", still deferred.
- `open-file` is registered at MODULE scope (macOS fires it before
  `whenReady`) and every producer enqueues into `createWorkspaceOpenQueue`,
  which holds requests until the main window's `did-finish-load` proves a
  renderer is listening. `second-instance` is registered only when not in E2E
  mode, so its argv handling is unit-tested and shares the queue the
  `open-file` e2e proves end to end — it has no e2e of its own, deliberately.
- The drop surface is the composer's workspace bar only (spec §4.1's wording).
  It gates on `dataTransfer.types.includes('Files')` BEFORE `preventDefault()`,
  so internal pragmatic-drag-and-drop drags pass through — the same discipline
  `notes-vault-panel.tsx` uses. Files are told apart from folders by
  `webkitGetAsEntry().isDirectory`, synchronously inside the drop tick, and
  skipped items are COUNTED and stated. An Explorer-sidebar drop zone is a
  named follow-up, not a silent omission.
```

Also amend the "second (and last) sanctioned picker-less mount" bullet with one sentence so a future reader cannot mistake W6's new entry points for a third door:

```md
  BST-1393 added four new CALLERS of this path (File ▸ Open Recent, argv,
  `open-file`, folder drag-drop) and NO new authorization: each is a request
  that these same two gates still decide, and a refusal is surfaced with the
  picker as its remedy.
```

- [ ] **Step 3: `docs/agents/ui-conventions.md`**

In the CONTEXT ACTION SYSTEM section's Rules list, after the "Adding a surface" bullet:

```md
- Surface inventory of `ContextTarget` kinds includes `workspace-root`
  (BST-1393): the Explorer's per-root section header. It carries the
  workspace-wide MAIN role (`isMain`) and a `path` that is `null` for a
  browser FSA root, so its path-shaped actions gate with `isVisible` rather
  than `isEnabled`. Its menu wraps ONLY the header — the per-root tree pane
  keeps its own `ActionContextMenu` as a SIBLING, because nesting two Radix
  context menus lets the outer one open against a target the inner one
  claimed. A host package that cannot be imported by the surface's own
  package contributes actions through an injected `rootActions` prop, the
  same seam `FileExplorerPanel`'s `selectionActions` established.
```

- [ ] **Step 4 (VERIFY + commit)**

```bash
pnpm run type-check
pnpm run lint:eslint
pnpm dlx ultracite check
npx react-doctor . --scope changed --base <task-13-sha> --verbose -y
pnpm --filter @brainstrike/context-actions test
pnpm --filter @brainstrike/file-explorer-ui test
pnpm --filter @brainstrike/app-shell test
pnpm --filter @brainstrike/assistant-ui test
pnpm --filter @brainstrike/desktop test
```

```bash
git add -A && git commit -m "docs(BST-1393): close the root-header ContextTarget deferral

Records the workspace-root kind and its three action owners, the Set as Main
vs Make primary ruling, and the five-entry-point connection contract whose
whole point is that it added no new authorization.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Definition of done

- [ ] `ContextTarget` carries `workspace-root`; right-clicking an Explorer root header opens a menu with Set as Main (hidden on the Main root), New Thread Here, Copy Path, Reveal, Open in Terminal and a STAGED Disconnect…, and `rg -n "root headers have no ContextTarget kind yet"` finds nothing outside historical plan documents.
- [ ] Open in Terminal from a root header lands a shell whose `pwd` is that root — proven in desktop E2E, not by a seam-call assertion alone.
- [ ] Web renders none of Reveal / Open in Terminal, and Copy Path is absent for a pathless FSA root — by capability and by data, with no `isElectron()` anywhere in the change.
- [ ] File ▸ Open Folder… (⌘O) asks the focused renderer to run its own picker; File ▸ Open Recent lists granted folders newest-first, is disabled when empty, and its Clear Menu touches ONLY `app.clearRecentDocuments()`.
- [ ] `app.addRecentDocument` is called on every grant-recording mount.
- [ ] `brainstrike <path>`, `open-file` and `second-instance` argv all enqueue and deliver; an `open-file` for a GRANTED folder mounts it and one for a NEVER-granted folder refuses with the "Add folder…" remedy and mounts nothing — both proven in desktop E2E.
- [ ] Dropping a folder on the composer connects it; the ring arms only for `Files`; skipped files and unreadable folders are counted and stated. The real-Finder-drop leg is recorded from the manual CDT step.
- [ ] `rg -n "recordRecentRoot" apps/desktop/src` shows NO new call site: W6 added no third picker-less authorization.
- [ ] `pnpm run type-check`, `pnpm run lint:eslint`, `pnpm dlx ultracite check`, `npx react-doctor . --scope changed --base <previous-task-sha> --verbose -y`, and every touched package's `test` green **in one run**.
- [ ] `pnpm --filter @brainstrike/desktop run test:e2e:lane:smoke` green, with NO new file added to the lane list.
- [ ] CDT computed values (menu item labels + `aria-disabled`, menu rect vs the header row, drop-zone ring in both themes, the refusal toast's rendered strings) pasted into the PR, plus the manual Finder-drop outcome.
- [ ] `docs/agents/workspace-context.md` and `docs/agents/ui-conventions.md` updated in-band.

---

## Self-review (performed 2026-08-27, against `origin/integration/workspace-checkout-awareness` @ `e51e4dda5`)

**1. Spec coverage.** §7 bullet 1 (Recents + `app.addRecentDocument`, re-mount by path with the `SecureRoot` probe, "Folder not found" visible) ✓ Tasks 6–7 — with §7 [D9]'s *second* half ("Remove from recents") named out of scope with its reason and its W1 citation. §7 bullet 2 (Open Folder… ⌘O; `brainstrike <path>` / `second-instance` / `open-file` **[D10]**) ✓ Tasks 7–10; the command-palette half of that bullet is DELIVERED by Task 7's final step (ruled IN at plan review): a `GlobalCommandHandlers` entry via `createGlobalCommands` — the targetless-command idiom whose `openQuickOpen` member is the documented precedent (`bridgeActionToCommand` cannot express it: it binds a target eagerly and returns null without one). §7 bullet 3 (zero-root CTA) is ALREADY shipped by W1 and unchanged. §7 bullet 4 (the `workspace-root` ContextTarget, all six items) ✓ Tasks 1–4. §4.1's "drag a folder onto the composer" **[D7]** ✓ Tasks 11–12. §12 (web omits, never stubs) ✓ every surface, four distinct mechanisms (no bridge, no capability, `path: null`, host not mounted). §13 (no silent fallbacks) ✓ the refusal contract, the malformed-payload drop, the counted drop skips, the `''` path report. §14 (unit + desktop E2E + live CDT) ✓ Tasks 13–14, with a coverage table that says out loud which legs have NO automated proof.

**2. Placeholder scan — stated honestly, including where this plan is thinner than elsewhere.** **Every PRODUCTION code block is complete and paste-ready.** Four blocks deliberately defer to a read-at-HEAD, each naming the exact `rg` command and the exact identifier to substitute rather than guessing: the sidebar test harness (Task 3 Step 5), `addSelectedRoot`'s return type (Task 7 Step 3), main's storage-adapter and created-window identifiers (Task 7 Step 4 / Task 10 Step 3), and the terminal e2e helper names (Task 13 Step 1). One in-flight correction is stated where it will bite: `use-connect-folder` contains JSX and must be named `.tsx`.

**Five TEST steps are enumerated as exhaustive case lists rather than written-out code** — Task 6 Step 5 (`workspace-connect-host`), Task 9 Step 1 (`workspace-open-queue`), Task 10 Step 4 (main lifecycle), Task 12 Step 4 (`use-folder-drop`), and Task 13's e2e helper names. Each list names every case, its exact assertion target and its falsifier, so nothing is left to invention; but they are lists, not paste-ready blocks, and the implementer writes them against the harness they read at HEAD. Calling that out beats claiming a completeness the document does not have. No "similar to task N". No TODO. No NUL bytes (verified by byte count, and the backslash-u-0000 escape appears nowhere).

**3. Symbol existence — every symbol verified by `git grep` / `git show` against the integration tip, not memory.** `ContextTarget`/`ContextTargetKind`/`TargetOf`/`defineContextAction`/`ContextAction`/`AnyContextAction`/`CapabilityKey`/`ActionServices`/`ActionOutcome` (`packages/context-actions/src/types.ts`) ✓. `createActionRegistry`/`actionsFor`/`assertUniqueActionIds` ✓. `ActionContextMenu`/`useContextMenuTarget`/`ContextMenuTargetController`/`localActions`/`onCloseAutoFocus`/`onContextMenuCapture` convention (`packages/ui/src/context-menu/action-context-menu.tsx`) ✓. `fileEntryActions`/`revealLabel`/`fileNodeToTarget` and the `./context-actions` subpath export ✓. `buildVaultLocalActions` (the local-actions precedent) ✓. `RootSectionHeaderProps` + `data-testid="root-section-header-row"` / `"root-section-header"` / `"root-main-badge"` ✓. `RootSection`/`RootSectionInner`'s `rootIdentity`, `resolvedRootId`, `rest.mainRootId`, `rest.currentFolderId`, `handleDisconnectRequest`, `setIsDisconnectDialogOpen`, `DisconnectRootDialog`, `useFileExplorerStoreSelector` ✓. `setMainRoot` (`packages/file-explorer/src/actions/active-root-actions.ts:96`) and its existing menu-shaped consumer `workspace-root-status-item.tsx:167` ✓. `FileExplorerPanelProps.selectionActions` + `<FileExplorerPanel selectionActions={importAction} />` (`explorer-search-tabs.tsx:141`) ✓ — the injection precedent. `useTerminalTargetStore.openTerminalAt`/`reset`, `isTerminalBridgeAvailable`, `useWorkspaceBarTerminal` ✓. `handleCreateThreadInFolder` (`threads-panel.tsx:3165`) + `onNewThreadInFolder` (`:3440`) ✓. `resolveGrantedRootHandle`, `NEVER_GRANTED_MESSAGE` and BOTH literal refusal strings, `recordRecentRoot`, `recordRecentRootIfNew`, `listRecentRootEntries`, `RECENT_ROOTS_LIMIT = 50`, `RECENT_ROOTS_STORAGE_KEY` ✓ (`workspace-recent-roots.ts`). `WorkspaceRootRegistry.addRootByPath`/`addRoot`/`listRecentRoots` + `createSecureRoot` realpath probe ✓. `registerFileSystemIpcHandlers` options object + the `fs:addRoot` / `fs:addRootByPath` handlers ✓. `DESKTOP_IPC_CHANNELS.commandPalette.open` + its one-way-push comment convention, `preload.ts`'s `COMMAND_PALETTE_OPEN_EVENT` / `QUICK_OPEN_OPEN_EVENT` blocks, `shouldExposeBridge`, `electron.d.ts`'s `commandPalette?` / `quickOpen?` members, `command-palette-host.tsx`'s local resolver ✓. `main.ts`'s `menuTemplate` (1893) + `Menu.setApplicationMenu` (2050) + the focused-window click idiom (1920-1927) + `requestSingleInstanceLock` (1437) + `second-instance` (1455, arg-less, `if (!e2eTestMode)`) + `app.whenReady` (1478) ✓; `app.on('open-file')`, `role: 'fileMenu'`, `app.addRecentDocument` confirmed ABSENT. `resolveDesktopRendererLaunchMode` + `desktop-launch-mode.test.ts` (the pure-argv precedent) ✓. `webUtils.getPathForFile` present in the installed Electron typings (`apps/desktop/node_modules/electron/electron.d.ts:19733`) on catalog `electron ^43.4.0` ✓. `toast` + `ToastAction` + `persistent` semantics (`packages/ui/src/use-toast.ts`, used at `rewind-confirm-dialog.tsx:193`) ✓. `extractDroppedVaultDirectories` + `dragCarriesFiles` + the drop-tick test that invalidates its items ✓. `seedRoot({recentPaths, reloadReason, rootId})`, `test:e2e:lane:smoke`'s file list including `add-root-ui.smoke.desktop.test.ts` and `workspace-bar.desktop.test.ts` ✓. `preload-runtime-contract.test.ts`'s `expectedConstants` + `expectedBridgeMethods` maps ✓. `isContained`/`pathsEqual`/`pathKey` ✓.

**4. Type consistency.** `exactOptionalPropertyTypes: true` verified (`packages/config/tsconfig/base.json:22`) — every optional supply uses a conditional spread (`...(target.path === null ? {} : { path: target.path })`, `...(folder.path ? { operatingRootPath: folder.path } : {})`, `...(addRootDirectoryByPath ? { connectPath } : {})`), never `key: undefined`. New union member fields are alphabetical, matching the existing `changed-file` / `worktree` members. New props use the optional-KEY idiom (`onDropItems?: … | undefined`, `rootActions?: … | undefined`), matching `WorkspaceBarProps.onCopyPath`/`onOpenTerminal` rather than `WorkspaceBarMode`'s required-key/undefined-value form — each file keeps its own idiom rather than a single invented rule. IPC payloads are `unknown` and narrowed by `isWorkspaceOpenPathRequest`. No `any` anywhere.

**5. Falsifiability audit.** Task 1: the "never treats the root id as a path" case fails an implementation that derives `path` from `rootId`. Task 2: `isEnabled` is asserted `toBeUndefined()` — a disabled-instead-of-hidden implementation fails. Task 3: right-clicking the tree container asserts NO root menu, which a claim-without-reset implementation fails. Task 4: the terminal case asserts `createThreadInFolder` was NOT called and vice versa, and a third case pins the capability gate itself — the case the other two could never observe failing (the exact phantom-harness defect BST-1457 hit at Task 5). Task 6: the ENOENT case asserts `action` is `undefined`, which a "any error offers the picker" implementation fails. Task 7: the empty-ledger case pins `enabled: false` with an EMPTY submenu, and the cap case pins 12 rows, so an uncapped or hidden-when-empty implementation fails. Task 8: the unpackaged case fails a naive "everything after argv[0]" parse — the defect that would mount the repo on every dev launch. Task 11: the plain-file case asserts `resolvePath` was NOT called, which a blind-send implementation fails; the microtask-invalidated items fail a lazy one. Task 13: the `pwd` assertion is the falsifier a header-label-only Open-in-Terminal passes, and the never-granted `open-file` case is the falsifier a "just mount it" implementation passes.

**6. Verified-by-execution, not assumed.**

**Every fixture in this plan that could be run WAS run.** The three pure functions were implemented exactly as written here and executed against their own test expectations under Node before this plan shipped:

- `resolveFolderCandidatesFromArgv` (Task 8) — all **8** cases pass, including the unpackaged app-path skip, `.` resolving to the working directory, the switch filter, and the trailing-separator dedupe (which relies on `path.resolve` stripping it — confirmed, not assumed).
- `extractDroppedFolderPaths` (Task 11) — all **6** cases pass, including the microtask-invalidated `DataTransferItem` (which proves the drop-tick contract is enforced by the fixture, not merely documented), the `resolvePath`-not-called assertion for a plain file, and the dedupe.
- `buildFileMenuTemplate` (Task 7) — all **5** cases pass, including the **12**-row cap arithmetic (10 folders + separator + Clear Menu) and the disabled-with-empty-submenu state. The row count in the test is a computed result, not a guess.

The remaining fixtures cannot be run before the code exists (they assert against React trees, Electron mocks and a live app). Also ran during planning: `webUtils.getPathForFile` exists in the installed Electron 43 typings (grepped the real `electron.d.ts` in `apps/desktop/node_modules`, not from memory). `noExcessiveCognitiveComplexity`'s `maxAllowedComplexity: 20` read from the real ultracite preset in `node_modules`, and `noExcessiveLinesPerFile`'s `maxLines: 1000` plus the full exemption allowlist read from `biome.json` — which is how the plan can state that `main.ts` / `preload.ts` / `file-explorer-panel.tsx` are exempt and `file-explorer-sidebar.tsx` (981 lines) is NOT. File sizes measured (`git show … | wc -l`) for every hot file the plan touches. The absence of `app.on('open-file')`, `role: 'fileMenu'`, `app.addRecentDocument`, `webUtils` anywhere in the repo, and of ANY native drop handler outside `packages/notes-vault`, each confirmed by a repo-wide grep rather than assumed. The `context-action-registry.test.ts` fixtures that duck-type `window.platform` were READ — that finding is what changed ruling B1 from "extend `platform`" to "new bridge", and it is precisely the compiler-invisible fixture census this epic has been bitten by.

**7. Known risks the implementer must confirm at execution, each with its check.**
- *A `File` for a dropped DIRECTORY.* Chromium/Electron does produce one, and `webUtils.getPathForFile` is documented to resolve it, but this plan did not run a real Finder drop. Task 14's manual step is the check, and Task 11's `unresolvedCount` is the honest behaviour if it ever returns `''`.
- *`contextBridge` passing a `File` argument.* Electron's own `webUtils` documentation shows exactly this preload shape, but confirm in the CDT session before trusting the drop path.
- *Menu rebuild ordering.* `registerIpcHandlers` runs before the menu block; if the grant subscriber cannot reach `scheduleApplicationMenuRebuild` from there, Task 7 Step 4 names the module-level holder rather than moving menu construction earlier (which would read the ledger before `restoreRoots`).
- *`did-finish-load` on reload.* `attach` is idempotent by construction; confirm with the Task 10 lifecycle test that a second attach re-delivers nothing.

**8. Open questions for the coordinator (none blocking; each has a stated default the plan implements).**
1. **The Explorer sidebar as a second drop surface.** The brief said "composer/Explorer"; the spec says "composer". Default implemented: composer only, with the extraction and the zone component factored for a props-only follow-up. Say the word and it is one more task in Layer 4.
2. **A fifth `WorkspaceOpenOrigin: 'drop'` — RULED IN at plan review** (the via-vocabulary lesson: a refusal log's `origin` is the diagnostic someone reads when asking how a folder got here, and it must name the real gesture). Both union copies, `WORKSPACE_OPEN_ORIGINS`, Task 12's call site, and Task 5's narrowing-test census carry it; `WorkspaceOpenRequest` now imports the union instead of duplicating it inline.
3. **`defaultPath`-seeded picker for the refusal remedy.** Would make the never-granted case a single confirming click instead of a click plus navigation, at the cost of widening `requestDirectoryAccess()` across five packages including the web adapter that cannot honour it. Default: not in W6.
4. **A ⌘K "Open folder…" command — RULED IN at plan review, delivered by Task 7 Step 8.** The concrete one-entry idiom is `createGlobalCommands`/`GlobalCommandHandlers` with `openQuickOpen` as the targetless precedent; the originally-cited `bridgeActionToCommand` was the wrong idiom (eager target binding drops targetless commands from the palette).
