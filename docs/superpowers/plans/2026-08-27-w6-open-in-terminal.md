# W6 — Open in Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the ONE action the epic deliberately left unbuilt: **open a checkout in a terminal, at that checkout's own path**. A Worktree Map card, the composer's Mode chip (in worktree mode) and the Folder chip's root rows each gain **Open in Terminal**; selecting it pins the existing desktop Terminal workspace app to that checkout and reveals it. The W5 absence-assertion tripwire is DELETED in the same change that adds the action, exactly as its own comment instructs.

**Architecture:** No new bridge domain, no new table, no new main service. BrainStrike already owns a real PTY seam (`apps/desktop/src/terminal-ipc-handlers.ts` → `window.terminal` → `packages/app-shell/src/terminal-panel/`), but it is addressable ONLY as "the focused workspace root" (`useActiveRootId()`) and pins the shell cwd to the root itself. W6 makes that seam **targetable** in two small, honest increments:

1. **main:** `terminal:create` accepts an optional `cwd`, realpath'd and containment-checked INSIDE the already-validated root. Absent ⇒ today's behavior byte-for-byte. This is what lets a worktree nested under an open root (the `.claude/worktrees/<name>` topology every external tool uses) get a shell at its OWN path instead of the parent repo's.
2. **renderer:** a session-lived `terminal-target-store` (the `changes-navigation-store` idiom) holding a standing `{ cwd, rootId }` pin. `openTerminalAt(target)` sets the pin, switches the shell route to `explorer`, and opens the Terminal app tab. `TerminalPanel` renders `target ?? focused root`, and offers an explicit **Follow focused folder** release so a pin is never a trap.

Every call site is desktop-only by omission: the handler is supplied only when `isTerminalBridgeAvailable()` is true, so web (no `window.terminal`) renders no menu item anywhere — never a disabled stub.

**Tech Stack:** TypeScript strict (no `any`), React 19 + Tailwind CSS v4, Radix DropdownMenu via `@brainstrike/ui`, Electron main/preload/renderer bridge domains, node-pty, xterm.js, zustand, Vitest (unit + `*.integration.test.*`), Playwright desktop E2E, Chrome DevTools MCP for live verification, Biome/Ultracite.

**Linear:** epic [BST-1387](https://linear.app/brainstrike/issue/BST-1387) → **BST-1457** "Open in Terminal — terminal-target seam + Worktree Map / Mode chip surfaces" (CONFIRMED in Linear, filed 2026-08-27; the seam this plan builds is also consumed by BST-1393's workspace-root context-menu item, which stays out of scope here). The ticket id appears in commit prefixes AND in shipped source/doc strings — all sites use BST-1457. **Spec:** `docs/superpowers/specs/2026-08-21-workspace-checkout-awareness-design.md` §4.1, §4.3, §6.1, §10, §12, §13, §14. **Depends on:** W3 (BST-1390) and W5 (BST-1392), both landed on `integration/workspace-checkout-awareness`.

> **Branch point (read before you start, and before you review):** **W6 branches from `integration/workspace-checkout-awareness` at or after `3d54958160`.** That tip is where `packages/app-shell/src/worktree-map/`, the `Open in Terminal` tripwire, and the durable A6 ruling paragraph in `docs/agents/changeset-diff.md` all exist. A checkout that predates it will read this plan's Layer-2 references as phantoms — they are not. Verify before starting:
>
> ```bash
> git merge-base --is-ancestor 3d54958160 HEAD && echo "OK: post-W5" || echo "STOP: rebase onto integration first"
> ```

---

## Global Constraints

Every task's requirements implicitly include this section.

- **NO SILENT FALLBACKS.** A checkout that cannot get a terminal says why. `terminal:create` refuses an out-of-root, non-absolute, non-existent or non-directory `cwd` with a structured `{ ok:false, error }` and spawns nothing. A Map card whose checkout is not inside any open folder (`entry.rootId === null`) does not offer the action at all — it already offers **Add as root**, which is the honest next step. The panel keeps its existing visible `error`/`exited` states; nothing degrades to "a shell somewhere else".
- **Never a wrong cwd.** `WorktreeListEntry.rootId` is *"the first live workspace root CONTAINING this worktree"*, **not** the checkout's own mount (`rootIdIsExactMount` is the flag for that — see `packages/types/src/worktree.ts`). Handing `rootId` alone to `terminal:create` would silently open the shell in the PARENT repo for every nested worktree. That is precisely why Task 1 exists: every call site passes `{ cwd: <checkout path>, rootId: <containing root> }` and main pins the shell to `cwd`.
- **Capability gating by omission, never `isElectron()`.** Every surface takes the handler as an optional prop and renders the item only when the prop exists. app-shell supplies it only behind `isTerminalBridgeAvailable()`. Web has no `window.terminal`, therefore no item, therefore no stub.
- **Absent, never disabled — until it is real.** Two removals, two DIFFERENT shapes, each in the SAME task that adds its real action: the W5 Map tripwire (`packages/app-shell/src/worktree-map/__tests__/worktree-map-surface.test.tsx`, `'offers no "Open in Terminal" action anywhere on a card (W6 owns the seam)'`) is a standalone `it()` — delete the WHOLE test; the Mode-chip absence assertion (`packages/assistant-ui/src/__tests__/mode-chip.test.tsx:504`) lives INSIDE `'offers the in-worktree menu items ONLY when their handlers exist'` — remove ONLY the two assertion lines, preserving that test and its other visibility assertions. Never weakened, never left standing alongside a stub.
- **One terminal code path.** All three surfaces publish to the SAME `terminal-target-store`; `TerminalPanel`/`useTerminalSession` stay the only consumers of `window.terminal`. No surface talks to the bridge directly.
- **Falsifying wiring tests.** Every "surface A calls store B" test uses a DISTINCT `vi.fn()` per action, asserts `toHaveBeenCalledTimes(1)` with exact arguments, AND asserts the sibling mocks were `not.toHaveBeenCalled()`.
- **TypeScript strict, no `any`.** `exactOptionalPropertyTypes: true` is on (`packages/config/tsconfig/base.json:22`) — an optional property is supplied with a conditional spread (`...(cwd === null ? {} : { cwd })`), never `cwd: undefined`. `unknown` + narrowing at every IPC boundary; kebab-case filenames; `use-*.ts` hooks exporting camelCase; components export PascalCase.
- **Biome:** `noExcessiveLinesPerFile` maxLines **1000** (error). **Verified empirically during planning (2026-08-27):** the rule counts CODE lines, not physical lines — a 1100-physical-line file of 900 code + 200 comment lines passes, and `packages/app-shell/src/hooks/use-workspace-bar.ts` (1041 physical, ~749 code) passes `biome check` today. So the operative rule is: after editing any file this plan touches, run `pnpm exec biome check <file>` and split only if the rule actually fires. Headroom at HEAD: `use-workspace-bar.ts` ~749 code lines, `use-worktree-mode.ts` ~790, `worktree-service.ts` (1040 physical) — **W6 does not touch `worktree-service.ts` at all**. Object/JSX props sorted alphabetically; cognitive complexity ≤ 20. `pnpm dlx ultracite fix <files>` before every commit.
- **Testing lanes:** Vitest unit for pure logic and hooks; `*.integration.test.ts` for the real-node-pty layer (excluded from the cached `test` lane, run by `test:integration`); Playwright desktop E2E. Both e2e files this plan touches (`e2e/worktree-map.desktop.test.ts`, `e2e/terminal-panel.desktop.test.ts`) are ALREADY registered in `apps/desktop/package.json`'s `test:e2e:lane:smoke` list — **no lane registration is needed, and none may be added**. **Live CDT verification is part of the definition of done** — report COMPUTED VALUES (rects, `disabled`, `aria-*`, header text), never impressions.
- **Stack:** one branch per layer on trunk `integration/workspace-checkout-awareness`, created with `gh stack add`. NEVER target `main`. Land bottom-up. Commit messages `feat|fix|test|docs(BST-1457): …` with trailer:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```
- **Gates before each PR:** touched packages' `test`, root `pnpm run type-check`, `pnpm run lint:eslint`, `pnpm dlx ultracite fix <files>`, `npx react-doctor . --scope changed --base <previous-task-sha> --verbose -y` (no NEW error-severity findings in touched files — corrected at execution, Task 3 review, 2026-08-27: the bare `pnpm run react-doctor` script pins `--scope full`, which is repo-wide and always non-zero on pre-existing baseline debt). Pristine output — no `act()` warnings, no unasserted logger lines.
- **Docs in-band**, in the same PR as the code: `docs/agents/changeset-diff.md` (replace the A6 deferral paragraph), `docs/agents/workspace-context.md` (the FOCUSED-root/terminal-cwd contract).
- `@mastra/core` stays Node-only/externalized; local inference stays renderer-only. Nothing here touches either.

---

## Scope boundaries (read before starting)

**In scope (W6):** an optional containment-checked `cwd` on `terminal:create`; the renderer `terminal-target-store` + its factory-reset wiring; `TerminalPanel`/`useTerminalSession` honoring a pinned target and offering an explicit release; **Open in Terminal** on (a) Worktree Map cards, (b) the Mode chip's worktree menu, (c) the Folder chip's root rows; deletion of the two absence assertions; desktop E2E; a CDT probe; the two living-doc updates.

**Explicitly OUT of scope (owner named):**
- **`window.worktrees.openInTerminal`** — spec §6.1 lists it on the worktree bridge, but no main-side worktree operation is involved: the terminal is a renderer-driven panel, and the mutation-free "show me a shell here" request has no business round-tripping through `WorktreeService`. **The `worktrees` bridge exact set stays at its current size and gains no member.** Recorded as ruling **T1** below.
- **Launching the OS terminal emulator** (Terminal.app / iTerm / `wt`). Rejected — ruling **T2** below.
- **The `workspace-root` ContextTarget context menu (§7)**, `File ▸ Open Recent`, `brainstrike <path>`, `open-file`, folder drag-drop **[D7, D10]** — spec §15's original W6 row. The coordinator re-scoped W6 to Open-in-Terminal alone; those remain unbuilt and unowned by this plan.
- **"Remove from recents" (§7)** — deferred alongside Open-in-Terminal by W1 (`2026-08-21-w1-workspace-bar-foundation.md:25`). It needs a main-side ledger mutation plus its own factory-reset and corruption story. Still deferred; W6 does not touch it.
- **Multiple concurrent terminal sessions / a terminal tab strip.** The panel remains a single session that re-keys on its target. Out of scope, no ticket.
- **Run-scoped `git worktree lock`** (W3 ruling A5) and **indexing-on-by-default for worktree roots [D8]** — unchanged.

**Sibling-PR collisions to watch:** `packages/app-shell/src/hooks/use-worktree-mode.ts`, `packages/assistant-ui/src/workspace-bar/mode-chip.tsx` and `packages/app-shell/src/hooks/use-workspace-bar.ts` are hot files across this epic. Re-read each at HEAD before applying a diff; do not apply blind. This plan adds NO migration and NO table, so the migration space is collision-free.

---

## Resolved spec ambiguities (read before Task 1)

| # | Ambiguity | Resolution used by this plan |
| --- | --- | --- |
| T1 | §6.1 lists `openInTerminal` on `window.worktrees`, and §10 lists the action on a Map card. Which seam owns it? | **Neither the worktree bridge nor a new bridge.** The action opens an in-app panel; it mutates nothing and needs no main-side worktree state. It routes through the renderer `terminal-target-store` and the EXISTING `window.terminal` bridge. `WORKTREES_BRIDGE_REQUIRED_METHODS` is untouched, so `apps/desktop/src/__tests__/preload-runtime-contract.test.ts` needs no change for the worktrees domain. This is a **deliberate, stated deviation from §6.1's literal placement**: the spec's intent is that the action exists and lands the user in a shell at the checkout; putting a UI-navigation request on a main-process git service would add an IPC hop, a second failure surface, and a bridge member that does no work. |
| T2 | "Open in Terminal" could mean the user's OS terminal emulator (Cursor/Conductor parity) or BrainStrike's own Terminal workspace app. | **BrainStrike's own Terminal app.** Three reasons, in order of weight: (1) the durable A6 ruling in `docs/agents/changeset-diff.md` says the blocker was *"no terminal-session seam a worktree path can be handed to"* — an `open -a Terminal <path>` call needs no *session* seam and could have shipped in W1 via the long-existing `platform.showItemInFolder`/`openExternal`; the ruling is about the in-app PTY; (2) spawning an external emulator at an arbitrary path bypasses the root-containment model that `resolveRootCwd` exists to enforce — the app would be handing a shell to a path it never validated; (3) there is no honest cross-platform story (macOS `open -a`, Windows `wt`, Linux: nothing reliable), and NO SILENT FALLBACKS forbids picking one and hoping. An external-emulator action can be added later as a separate, explicitly-configured affordance; it is not what W6 owes. |
| T3 | `terminal:create` takes a `rootId` and pins the shell to the ROOT. A worktree is often not its own root. | Task 1 adds an optional `cwd` that must resolve (realpath) INSIDE the already-validated root. Three real topologies motivate it: a managed worktree under `~/.brainstrike/worktrees/…` is mounted as its own root (`rootIdIsExactMount: true`) and works either way; a worktree nested under an open repo (`.claude/worktrees/x`, `.codex/worktrees/x`) has `rootId` = the PARENT and `rootIdIsExactMount: false` — without `cwd` the shell would silently open in the parent repo; the primary checkout card IS the open root and works either way. One parameter removes the whole class. |
| T4 | Should the target be a one-shot intent (`worktree-checkout-intent-store`) or a standing pin (`changes-navigation-store`'s `activeChangeset`)? | **A standing pin.** A one-shot would have to be consumed into `useState` inside an effect — the derived-state-mirror shape `react-doctor`'s `no-adjust-state-on-prop-change` flags and that `use-terminal-session.ts`'s own doc comment is written to avoid. The pin is derived during render (`target?.rootId ?? focusedRootId`), is inspectable, and is released by an explicit visible control. |
| T5 | A pin could strand the user: the panel would keep showing a worktree's shell while they click around the tree expecting the focused folder. | The panel renders a **Follow focused folder** button whenever a target is pinned (`data-testid="terminal-panel-clear-target"`), and the header already shows the live cwd. The pin is also cleared by factory reset. It deliberately SURVIVES a focus change — that is the whole point of asking for a specific checkout — and the release control is what makes that honest rather than a trap. |
| T6 | `openTerminalAt` must both open the Terminal app tab and reveal the workspace route. `changes-navigation-store.openChangeset` owns only the tab half and makes each caller pair it with `usePanelLayoutStore.setActiveTab('explorer')`. | **This store owns both halves.** W6 has three callers and all three need the identical pair; splitting it would be three copies of the same two-line dance. `useTerminalHotkey` (`packages/file-explorer-ui/src/shell/use-terminal-hotkey.ts`) already sets the precedent of doing both together for the Terminal app specifically. The route switch is idempotent, so calling it from the Map (already on that route) is a no-op. |
| T7 | The Map card menu has an item for every state; what does an unmountable checkout get? | `Open in Terminal` renders exactly when `entry.rootId !== null`; `Add as root` renders exactly when `entry.rootId === null`. The two are complementary, so the menu always names the next step and never shows a dead action. No disabled variant. |

---

## Dependency DAG (execution order and what may run in parallel)

```
          ┌─────────────────────────────────────────────────┐
          │ L1  terminal-target seam    (Tasks 1–3)         │  ← sequential base
          │ main cwd param → store → panel consumes target  │
          └───────────────────────┬─────────────────────────┘
                                  │
        ┌─────────────────────────┼──────────────────────────┐
        ▼                         ▼                          ▼
┌──────────────────┐   ┌─────────────────────┐   ┌───────────────────────┐
│ L2a  map-action  │   │ L2b  mode-chip      │   │ L2c  folder-chip      │
│ (Task 4)         │   │ (Task 5)            │   │ (Task 6)              │
│ app-shell/       │   │ assistant-ui +      │   │ assistant-ui +        │
│ worktree-map/**  │   │ use-worktree-mode   │   │ use-workspace-bar     │
└────────┬─────────┘   └──────────┬──────────┘   └──────────┬────────────┘
         └────────────────────────┼─────────────────────────┘
                                  ▼
          ┌─────────────────────────────────────────────────┐
          │ L3  verification            (Tasks 7–8)         │
          │ desktop E2E + CDT probe + living docs           │
          └─────────────────────────────────────────────────┘
```

**Parallel-execution rules for a fleet:**

- **L2a ∥ L2b ∥ L2c are genuinely file-disjoint.** L2a: `packages/app-shell/src/worktree-map/**`. L2b: `packages/assistant-ui/src/workspace-bar/mode-chip.tsx`, `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx` (the `WorkspaceBarMode` interface), `packages/assistant-ui/src/__tests__/mode-chip.test.tsx`, `packages/app-shell/src/hooks/use-worktree-mode.ts`. L2c: `packages/assistant-ui/src/workspace-bar/folder-chip.tsx`, `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx` (the `WorkspaceBarProps` interface), `packages/assistant-ui/src/__tests__/workspace-bar.test.tsx`, `packages/app-shell/src/hooks/use-workspace-bar.ts`. **L2b and L2c both edit `workspace-bar.tsx`** — different interfaces in the same file. If run in parallel worktrees, land L2b first and rebase L2c; if run serially, no conflict.
- **L1's three tasks are strictly sequential** — Task 2's store is what Task 3 consumes, and Task 3's panel is what Task 1's `cwd` reaches.
- **L3 is strictly after every L2 task** (its e2e drives the Map action end to end).
- **Landing order is linear** (`gh stack`): L1 → L2a → L2b → L2c → L3.

---

# Layer 1 — the terminal-target seam

## Task 1: `terminal:create` accepts a containment-checked `cwd`

**Files:** `apps/desktop/src/workspace-root-cwd.ts`, `apps/desktop/src/terminal-ipc-handlers.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/types/electron.d.ts`, `packages/app-shell/src/terminal-panel/terminal-bridge.ts`, `apps/desktop/src/__tests__/terminal-ipc-handlers.integration.test.ts`

**Interfaces this task lands:**

```ts
// apps/desktop/src/workspace-root-cwd.ts
export async function resolveContainedCwd(
  rootCwd: string,
  requested: string | undefined,
  domain: string
): Promise<RootCwdResult>;

// apps/desktop/src/terminal-ipc-handlers.ts
export interface TerminalCreateParams {
  readonly cols?: number;
  /** Absolute path INSIDE the resolved root; omitted ⇒ the root itself. */
  readonly cwd?: string;
  readonly rootId: string;
  readonly rows?: number;
}

// packages/app-shell/src/terminal-panel/terminal-bridge.ts
export interface TerminalBridge {
  create: (params: {
    rootId: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  }) => Promise<TerminalResult<TerminalCreateResult>>;
  // …unchanged members
}
```

- [ ] **Step 1 (RED): pin the containment contract**

Append to `apps/desktop/src/__tests__/terminal-ipc-handlers.integration.test.ts`, inside the existing `describe('terminal IPC handlers — cwd containment', …)` block (the file's `makeDir`, `fakeResolver`, `FakeWebContents`, `castOwner` helpers are already in scope):

```ts
  it('spawns in a subdirectory of the root when a contained cwd is supplied', async () => {
    const dir = await makeDir();
    const nested = path.join(dir, '.claude', 'worktrees', 'bright-fox');
    await fsPromises.mkdir(nested, { recursive: true });
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
    });
    const owner = new FakeWebContents(1);

    const created = await handlers.create(castOwner(owner), { cwd: nested, rootId: 'root-id' });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error);
    }
    // The REPORTED cwd is the nested checkout, not the containing root — the
    // whole point of the parameter (a nested worktree must not get the parent
    // repo's shell).
    expect(created.value.cwd).toBe(await fsPromises.realpath(nested));
    handlers.destroy({ terminalId: created.value.terminalId }, owner.id);
  });

  it('rejects a cwd outside the root without spawning', async () => {
    const dir = await makeDir();
    const outside = await makeDir();
    const spawn = vi.fn();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
      spawn: spawn as never,
    });

    const result = await handlers.create(castOwner(new FakeWebContents(1)), {
      cwd: outside,
      rootId: 'root-id',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/outside the open folder/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a sibling-prefix cwd that only looks contained', async () => {
    // `<root>-evil` starts with `<root>` as a STRING but is not inside it. A
    // naive `startsWith(rootCwd)` check passes this; the separator-anchored
    // check does not. This is the falsifier for the containment predicate.
    const dir = await makeDir();
    const sibling = `${dir}-evil`;
    await fsPromises.mkdir(sibling, { recursive: true });
    createdDirs.push(sibling);
    const spawn = vi.fn();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
      spawn: spawn as never,
    });

    const result = await handlers.create(castOwner(new FakeWebContents(1)), {
      cwd: sibling,
      rootId: 'root-id',
    });
    expect(result.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a relative, empty or non-directory cwd without spawning', async () => {
    const dir = await makeDir();
    const file = path.join(dir, 'hello.ts');
    await fsPromises.writeFile(file, 'export const value = 1;\n');
    const spawn = vi.fn();
    const handlers = createTerminalIpcHandlers({
      resolver: fakeResolver([{ displayName: 'root', path: dir, rootId: 'root-id' }]),
      spawn: spawn as never,
    });
    const owner = new FakeWebContents(1);

    const relative = await handlers.create(castOwner(owner), { cwd: 'sub', rootId: 'root-id' });
    expect(relative.ok).toBe(false);
    if (!relative.ok) {
      expect(relative.error).toMatch(/absolute/);
    }
    const empty = await handlers.create(castOwner(owner), { cwd: '   ', rootId: 'root-id' });
    expect(empty.ok).toBe(false);
    const notDir = await handlers.create(castOwner(owner), { cwd: file, rootId: 'root-id' });
    expect(notDir.ok).toBe(false);
    if (!notDir.ok) {
      expect(notDir.error).toMatch(/not a directory/);
    }
    const missing = await handlers.create(castOwner(owner), {
      cwd: path.join(dir, 'nope'),
      rootId: 'root-id',
    });
    expect(missing.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
```

Run it and see it fail (the `cwd` key does not exist yet — TypeScript errors are the RED signal here, plus the first case reporting the root instead of the nested path once the key is accepted):

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/terminal-ipc-handlers.integration.test.ts
```

- [ ] **Step 2 (GREEN): add `resolveContainedCwd`**

Append to `apps/desktop/src/workspace-root-cwd.ts` (below `resolveRootCwd`):

```ts
/**
 * Narrow an already-resolved root cwd to a REQUESTED subdirectory.
 *
 * `resolveRootCwd` answers "which open folder", this answers "where inside it".
 * The two are separate because the root answer is the authorization (an unknown
 * rootId is a hard refusal) while this is a containment narrowing: `requested`
 * must be absolute, must exist, must be a directory, and — after `realpath` on
 * BOTH sides — must be the root itself or lie beneath it.
 *
 * The containment test is SEPARATOR-ANCHORED (`${rootCwd}${path.sep}`), never a
 * bare `startsWith`: `/work/repo-evil` starts with `/work/repo` as a string and
 * is not inside it. Both sides are canonical before comparison, so a symlink
 * pointing out of the root cannot smuggle a path past the check.
 *
 * Error strings never embed a filesystem path (`platform-contracts.md`: cwd is
 * not something this layer hands back or logs at warn+).
 */
export async function resolveContainedCwd(
  rootCwd: string,
  requested: string | undefined,
  domain: string
): Promise<RootCwdResult> {
  if (requested === undefined) {
    return { ok: true, value: rootCwd };
  }
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    return { error: `${domain} requires a non-empty cwd string when one is supplied.`, ok: false };
  }
  if (!path.isAbsolute(requested)) {
    return { error: `${domain} requires an absolute cwd path.`, ok: false };
  }
  let canonical: string;
  try {
    canonical = await fsPromises.realpath(requested);
    const stats = await fsPromises.stat(canonical);
    if (!stats.isDirectory()) {
      return { error: 'The requested working directory is not a directory.', ok: false };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { error: 'The requested working directory no longer exists on disk.', ok: false };
    }
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  }
  if (canonical !== rootCwd && !canonical.startsWith(`${rootCwd}${path.sep}`)) {
    return { error: 'The requested working directory is outside the open folder.', ok: false };
  }
  return { ok: true, value: canonical };
}
```

- [ ] **Step 3 (GREEN): thread it through the handler**

In `apps/desktop/src/terminal-ipc-handlers.ts`:

1. Extend the import:

```ts
import {
  resolveContainedCwd,
  resolveRootCwd,
  type WorkspaceRootResolver,
} from './workspace-root-cwd';
```

2. Extend the params interface:

```ts
export interface TerminalCreateParams {
  readonly cols?: number;
  /**
   * Absolute path INSIDE the resolved root to pin the shell to. Omitted ⇒ the
   * root itself (the original, unchanged behavior). Supplied by the Worktree
   * Map / workspace-bar "Open in Terminal" surfaces so a worktree NESTED under
   * an open root gets a shell at its OWN path rather than the parent repo's.
   */
  readonly cwd?: string;
  readonly rootId: string;
  readonly rows?: number;
}
```

3. Replace the first four lines of `create`'s body:

```ts
    const root = await resolveRootCwd(resolver, params?.rootId, 'terminal', logger);
    if (!root.ok) {
      return root;
    }
    const cwd = await resolveContainedCwd(root.value, params?.cwd, 'terminal');
    if (!cwd.ok) {
      return cwd;
    }
```

Everything downstream already reads `cwd.value` (`spawn(..., { cwd: cwd.value, ... })`, `fingerprintCwd(cwd.value)`, `logger.info(..., { cwd: cwd.value, ... })`, `value: { cwd: cwd.value, terminalId }`) and needs **no further edit** — the rename from `cwd` to `root` plus the new `cwd` binding is the whole change.

4. Update the module doc comment's numbered item 1, replacing the sentence `` `terminal:create` takes a renderer-supplied `rootId` … then canonicalized via `realpath`. `` with:

```
 *    `terminal:create` takes a renderer-supplied `rootId` that is resolved +
 *    containment-checked against the DB-backed workspace roots (the SAME source
 *    the git / read / search tools use), then canonicalized via `realpath`. An
 *    optional `cwd` narrows the spawn to a SUBDIRECTORY of that root — also
 *    realpath'd, also containment-checked (separator-anchored, so a
 *    sibling-prefix path cannot pass), and required to be an existing directory.
 *    An unknown/escaping/web (FSA, non-absolute) root — or a cwd outside it — is
 *    REJECTED before any pty is spawned.
```

- [ ] **Step 4 (GREEN): widen the preload, the ambient type and the renderer bridge type**

`apps/desktop/src/preload.ts` — the `terminal` block (the `create` line only):

```ts
    create: (params: { rootId: string; cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke(TERMINAL_CREATE_CHANNEL, params),
```

`apps/desktop/src/types/electron.d.ts` — the `terminal?:` block's `create` signature:

```ts
      create: (params: {
        rootId: string;
        /** Absolute path inside the root; omitted ⇒ the root itself. */
        cwd?: string;
        cols?: number;
        rows?: number;
      }) => Promise<TerminalResult<TerminalCreateResult>>;
```

`packages/app-shell/src/terminal-panel/terminal-bridge.ts` — the `TerminalBridge.create` signature:

```ts
  create: (params: {
    rootId: string;
    /**
     * Absolute path inside the root to pin the shell to; omitted ⇒ the root
     * itself. Mirrors `TerminalCreateParams` in
     * `apps/desktop/src/terminal-ipc-handlers.ts`.
     */
    cwd?: string;
    cols?: number;
    rows?: number;
  }) => Promise<TerminalResult<TerminalCreateResult>>;
```

`TERMINAL_BRIDGE_REQUIRED_METHOD_SET` is a **key** set — adding a parameter does not touch it, and `apps/desktop/src/__tests__/preload-runtime-contract.test.ts` needs no change.

- [ ] **Step 5: verify**

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/terminal-ipc-handlers.integration.test.ts
pnpm run type-check
pnpm dlx ultracite fix apps/desktop/src/workspace-root-cwd.ts apps/desktop/src/terminal-ipc-handlers.ts apps/desktop/src/preload.ts apps/desktop/src/types/electron.d.ts packages/app-shell/src/terminal-panel/terminal-bridge.ts
```

- [ ] **Step 6: commit**

```bash
git commit -m "feat(BST-1457): terminal:create accepts a containment-checked cwd inside the root

A worktree nested under an open root (.claude/worktrees/<name>) resolves to
the PARENT root's id, so pinning the shell to the root alone would silently
open it in the parent repo. The optional cwd is realpath'd and
separator-anchored-containment-checked inside the already-validated root;
omitted, behavior is unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: the `terminal-target-store`

**Files:** `packages/app-shell/src/stores/terminal-target-store.ts` (new), `packages/file-explorer-ui/src/stores/workspace-tab-selection-store.ts`, `packages/app-shell/src/register-factory-reset-session-stores.ts`, `packages/app-shell/src/__tests__/terminal-target-store.test.ts` (new)

**Interfaces this task lands:**

```ts
// packages/app-shell/src/stores/terminal-target-store.ts
export interface TerminalTarget {
  /** Absolute path the shell is pinned to. */
  readonly cwd: string;
  /** Durable id of the granted workspace root that CONTAINS `cwd`. */
  readonly rootId: string;
}

export interface TerminalTargetState {
  /** Pin the Terminal app to `target`, reveal the workspace route, open the tab. */
  readonly openTerminalAt: (target: TerminalTarget) => void;
  /** Drop the pin; the panel returns to following the focused root. */
  readonly reset: () => void;
  readonly target: TerminalTarget | null;
}
```

- [ ] **Step 1 (RED): the store's own suite**

Create `packages/app-shell/src/__tests__/terminal-target-store.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openAppMock = vi.fn();
const setActiveTabMock = vi.fn();

vi.mock('@brainstrike/file-explorer-ui/workspace-tab-selection-store', () => ({
  TERMINAL_APP_ID: 'terminal',
  useWorkspaceTabSelectionStore: { getState: () => ({ openApp: openAppMock }) },
}));
vi.mock('@brainstrike/app-state/stores/panel-layout-store', () => ({
  usePanelLayoutStore: { getState: () => ({ setActiveTab: setActiveTabMock }) },
}));

import { useTerminalTargetStore } from '../stores/terminal-target-store';

const TARGET = { cwd: '/repo/.claude/worktrees/bright-fox', rootId: 'root-1' } as const;

describe('useTerminalTargetStore', () => {
  beforeEach(() => {
    openAppMock.mockReset();
    setActiveTabMock.mockReset();
    useTerminalTargetStore.getState().reset();
  });

  it('starts with no pin', () => {
    expect(useTerminalTargetStore.getState().target).toBeNull();
  });

  it('pins the target, reveals the workspace route, and opens the Terminal tab', () => {
    useTerminalTargetStore.getState().openTerminalAt(TARGET);

    expect(useTerminalTargetStore.getState().target).toEqual(TARGET);
    expect(setActiveTabMock).toHaveBeenCalledExactlyOnceWith('explorer');
    expect(openAppMock).toHaveBeenCalledExactlyOnceWith('terminal');
  });

  it('re-requesting the SAME target still re-opens the tab (idempotent write, not a no-op)', () => {
    useTerminalTargetStore.getState().openTerminalAt(TARGET);
    useTerminalTargetStore.getState().openTerminalAt(TARGET);

    expect(openAppMock).toHaveBeenCalledTimes(2);
    expect(setActiveTabMock).toHaveBeenCalledTimes(2);
  });

  it('reset drops the pin without touching the tab surfaces', () => {
    useTerminalTargetStore.getState().openTerminalAt(TARGET);
    openAppMock.mockReset();
    setActiveTabMock.mockReset();

    useTerminalTargetStore.getState().reset();

    expect(useTerminalTargetStore.getState().target).toBeNull();
    // Falsifier: clearing the pin must NOT close, re-open or re-route anything —
    // the user may be looking at the panel and just wants it to follow focus.
    expect(openAppMock).not.toHaveBeenCalled();
    expect(setActiveTabMock).not.toHaveBeenCalled();
  });
});
```

```bash
pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/terminal-target-store.test.ts
```

- [ ] **Step 2 (GREEN): re-export `TERMINAL_APP_ID` from the dependency-light store subpath**

`packages/file-explorer-ui/src/stores/workspace-tab-selection-store.ts` — extend the existing import and its re-export so a plain store module can name the Terminal app without dragging in the shell barrel (the file's own comment already states this is why the re-export exists):

```ts
import {
  CANVAS_APP_ID,
  CHANGES_APP_ID,
  CONTEXT_EXPLORER_APP_ID,
  TERMINAL_APP_ID,
} from '../shell/workspace-app';

// Re-exported so non-UI consumers (entry-point stores, factory reset) can
// reach the app ids through this dependency-light subpath instead of the
// shell barrel (which drags the whole UI graph into a plain store module).
export { CANVAS_APP_ID, CHANGES_APP_ID, CONTEXT_EXPLORER_APP_ID, TERMINAL_APP_ID };
```

- [ ] **Step 3 (GREEN): write the store**

Create `packages/app-shell/src/stores/terminal-target-store.ts`:

```ts
/**
 * Which checkout the desktop Terminal app is pinned to (BST-1457, spec §4.1,
 * §4.3, §10 "Open in Terminal").
 *
 * Session-lived and NON-persisted. The Terminal panel normally follows the
 * FOCUSED workspace root (`useActiveRootId`); this store is how a DIFFERENT
 * surface — a Worktree Map card, the Mode chip, a Folder chip root row — says
 * "open a shell in THIS checkout instead". The panel derives its session from
 * `target ?? focused root` during render, so this is one owned value read in one
 * place, not a second source of truth.
 *
 * `cwd` is the checkout's own absolute path and `rootId` is the granted root
 * that CONTAINS it — they are frequently DIFFERENT (a worktree nested under an
 * open repo resolves to the parent root's id; see `WorktreeListEntry.rootId` vs
 * `rootIdIsExactMount` in `packages/types/src/worktree.ts`). Main authorizes on
 * `rootId` and pins the shell to `cwd` after a containment check, so passing
 * both is what keeps the shell out of the wrong repository.
 *
 * Unlike `worktree-checkout-intent-store` this is a STANDING pin, not a
 * one-shot: a consume-and-clear intent would have to be mirrored into the
 * panel's `useState` inside an effect, which is exactly the derived-state
 * mirror `use-terminal-session.ts` is written to avoid (react-doctor
 * `no-adjust-state-on-prop-change`). The pin survives a focus change on purpose
 * — the user asked for a specific checkout — and the panel renders an explicit
 * "Follow focused folder" control that calls {@link TerminalTargetState.reset}.
 *
 * Unlike `changes-navigation-store.openChangeset`, `openTerminalAt` owns BOTH
 * halves of the navigation (shell route + workspace app tab). All three callers
 * need the identical pair, and `use-terminal-hotkey.ts` already sets that
 * precedent for this exact app id.
 */
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  TERMINAL_APP_ID,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { create } from 'zustand';

export interface TerminalTarget {
  /** Absolute path the shell is pinned to. */
  readonly cwd: string;
  /** Durable id of the granted workspace root that CONTAINS `cwd`. */
  readonly rootId: string;
}

export interface TerminalTargetState {
  /**
   * Pin the Terminal app to `target`, reveal the workspace route, and open (or
   * re-activate) the Terminal tab. UNCONDITIONAL on every call, so asking for
   * the same checkout twice still brings the tab back if the user clicked away
   * — the same reasoning `changes-navigation-store.openChangeset` documents.
   */
  readonly openTerminalAt: (target: TerminalTarget) => void;
  /**
   * Drop the pin so the panel follows the focused root again. Also the
   * factory-reset entry point (AGENTS.md: every session store wires into
   * reset) — a surviving pin would name an absolute path the reset just wiped.
   * Deliberately does NOT touch the tab surfaces: releasing a pin is not a
   * navigation.
   */
  readonly reset: () => void;
  readonly target: TerminalTarget | null;
}

export const useTerminalTargetStore = create<TerminalTargetState>((set) => ({
  openTerminalAt: (target) => {
    set({ target });
    // The workspace panel only exists on the `explorer` route; selecting the
    // Terminal tab alone would appear to do nothing with Git/Notes/Browser
    // active (`use-terminal-hotkey.ts` documents the same finding).
    usePanelLayoutStore.getState().setActiveTab('explorer');
    useWorkspaceTabSelectionStore.getState().openApp(TERMINAL_APP_ID);
  },
  reset: () => {
    set({ target: null });
  },
  target: null,
}));
```

- [ ] **Step 4 (GREEN): wire factory reset**

`packages/app-shell/src/register-factory-reset-session-stores.ts` — add the import (alphabetical among the relative imports, after `./thread-search-store`'s group placement is settled by `ultracite fix`):

```ts
import { useTerminalTargetStore } from './stores/terminal-target-store';
```

and append a registration block:

```ts
registerFactoryResetSessionStore(() => {
  // A pinned Terminal target names an absolute checkout path and a rootId the
  // reset just wiped; leaving it would point the panel at a folder that no
  // longer exists in this profile.
  useTerminalTargetStore.getState().reset();
});
```

Extend `packages/app-shell/src/__tests__/register-factory-reset-session-stores.test.ts`'s `'clears sibling session stores when factory reset drains registered resetters'` case: add `useTerminalTargetStore.getState().openTerminalAt({ cwd: '/wt', rootId: 'r-1' });` to the arrange block (importing the store at the top) and `expect(useTerminalTargetStore.getState().target).toBeNull();` to the assert block. The file already mocks nothing that the store needs beyond `zustand`; `openTerminalAt` will call the real `usePanelLayoutStore`/`useWorkspaceTabSelectionStore`, both of which are plain stores that work in jsdom.

- [ ] **Step 5: verify**

```bash
pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/terminal-target-store.test.ts src/__tests__/register-factory-reset-session-stores.test.ts
pnpm --filter @brainstrike/file-explorer-ui run test
pnpm run type-check
pnpm dlx ultracite fix packages/app-shell/src/stores/terminal-target-store.ts packages/app-shell/src/register-factory-reset-session-stores.ts packages/file-explorer-ui/src/stores/workspace-tab-selection-store.ts
```

- [ ] **Step 6: commit**

```bash
git commit -m "feat(BST-1457): add the terminal-target store and wire it into factory reset

A standing pin (changes-navigation-store idiom), not a one-shot intent: a
consume-and-clear would have to be mirrored into the panel's state inside an
effect. openTerminalAt owns both navigation halves because all three W6
callers need the identical route+tab pair.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: the panel honors a pinned target and offers a release

**Files:** `packages/app-shell/src/terminal-panel/use-terminal-session.ts`, `packages/app-shell/src/terminal-panel/terminal-panel.tsx`, `packages/app-shell/src/__tests__/terminal-panel.test.tsx`

**Interfaces this task lands:**

```ts
// packages/app-shell/src/terminal-panel/use-terminal-session.ts
export function useTerminalSession(
  rootId: string | null,
  cwd: string | null
): UseTerminalSessionResult;
```

- [ ] **Step 1 (RED): pin the panel behavior**

Append to the `describe('TerminalPanel', …)` block in `packages/app-shell/src/__tests__/terminal-panel.test.tsx`. The file's `installBridge`, `mockRoot`, `lastTerminal` helpers are already in scope; add the store import beside the existing `import { TerminalPanel } from '../terminal-panel/terminal-panel';` line:

```ts
import { useTerminalTargetStore } from '../stores/terminal-target-store';
```

and add `useTerminalTargetStore.getState().reset();` to the existing `beforeEach`. Then:

```ts
  it('creates the session at the FOCUSED root when nothing is pinned', async () => {
    const bridge = installBridge();
    render(<TerminalPanel />);

    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(1));
    const params = vi.mocked(bridge.create).mock.calls[0]?.[0];
    expect(params?.rootId).toBe('root-1');
    // No pin ⇒ no cwd key at all, so main takes its original root-cwd path.
    expect(params && 'cwd' in params).toBe(false);
  });

  it('creates the session at the PINNED checkout, carrying both rootId and cwd', async () => {
    const bridge = installBridge({
      create: vi.fn(async () => ok({ cwd: '/abs/repo/.claude/worktrees/bright-fox', terminalId: 'pty-2' })),
    });
    useTerminalTargetStore
      .getState()
      .openTerminalAt({ cwd: '/abs/repo/.claude/worktrees/bright-fox', rootId: 'root-1' });
    render(<TerminalPanel />);

    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(1));
    expect(bridge.create).toHaveBeenCalledWith({
      cols: 80,
      cwd: '/abs/repo/.claude/worktrees/bright-fox',
      rootId: 'root-1',
      rows: 24,
    });
    // The header reports the cwd main actually resolved, not the request.
    expect(await screen.findByText('/abs/repo/.claude/worktrees/bright-fox')).toBeInTheDocument();
  });

  it('offers "Follow focused folder" only while a target is pinned, and releasing it restarts at the root', async () => {
    const bridge = installBridge();
    render(<TerminalPanel />);
    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('terminal-panel-clear-target')).not.toBeInTheDocument();

    await act(async () => {
      useTerminalTargetStore.getState().openTerminalAt({ cwd: '/abs/repo/sub', rootId: 'root-1' });
    });
    const release = await screen.findByTestId('terminal-panel-clear-target');
    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(2));
    expect(vi.mocked(bridge.create).mock.calls[1]?.[0]).toMatchObject({ cwd: '/abs/repo/sub' });

    await userEvent.click(release);

    expect(screen.queryByTestId('terminal-panel-clear-target')).not.toBeInTheDocument();
    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(3));
    const third = vi.mocked(bridge.create).mock.calls[2]?.[0];
    expect(third?.rootId).toBe('root-1');
    expect(third && 'cwd' in third).toBe(false);
  });

  it('does not surface the previous target’s outcome after the pin changes within one root', async () => {
    // The freshness gate must key on the (rootId, cwd) PAIR: the lifecycle
    // effect re-runs on a cwd change WITHOUT bumping sessionId, so a gate that
    // keyed on rootId alone would leak the previous checkout's `exited` overlay
    // onto the freshly-starting one. This is the same bug class the existing
    // rootId note in use-terminal-session.ts describes.
    const bridge = installBridge();
    render(<TerminalPanel />);
    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(1));
    await act(async () => {
      exitCallback?.({ exitCode: 0, signal: null, terminalId: 'pty-1' });
    });
    expect(await screen.findByTestId('terminal-panel-exited')).toBeInTheDocument();

    await act(async () => {
      useTerminalTargetStore.getState().openTerminalAt({ cwd: '/abs/repo/sub', rootId: 'root-1' });
    });

    await waitFor(() =>
      expect(screen.queryByTestId('terminal-panel-exited')).not.toBeInTheDocument()
    );
  });
```

Add `act` to the `@testing-library/react` import at the top of the file if it is not already there.

```bash
pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/terminal-panel.test.tsx
```

- [ ] **Step 2 (GREEN): re-key the session on `(rootId, cwd)`**

`packages/app-shell/src/terminal-panel/use-terminal-session.ts` — five edits:

1. Replace the `TaggedOutcome` interface:

```ts
interface TaggedOutcome {
  readonly outcome: SessionOutcome;
  /**
   * The (rootId, cwd) PAIR this outcome belongs to, joined by a NUL that
   * neither component can contain. The lifecycle effect re-runs on a root
   * switch OR a target-pin change WITHOUT bumping `sessionId`, so the
   * render-time freshness gate must key on both — otherwise the previous
   * checkout's `exited`/`error` outcome leaks onto the freshly-starting one
   * until its `create()` resolves.
   */
  readonly sessionKey: string;
  readonly sessionId: number;
}
```

2. Replace the hook signature and add the key derivation immediately after the `bridge` resolution:

```ts
export function useTerminalSession(
  rootId: string | null,
  cwd: string | null
): UseTerminalSessionResult {
```

```ts
  // Derived during render, never stored: the identity of the session the panel
  // WANTS. NUL-joined because neither a rootId (uuid) nor an absolute path can
  // contain it, so no two distinct pairs can collide into one key.
  const sessionKey = `${rootId ?? ''}\u0000${cwd ?? ''}`;
```

3. Re-key the transient-retry budget:

```ts
  // A different target (root or pinned checkout) starts with a fresh
  // transient-retry budget.
  useEffect(() => {
    transientRetryCountRef.current = 0;
  }, [sessionKey]);
```

4. In the lifecycle effect: replace the guard `if (!(bridge && activeRootId && container))` with `if (!(bridge && rootId && container))`; replace the `create` call with

```ts
    bridge
      .create({ cols: term.cols, rootId, rows: term.rows, ...(cwd === null ? {} : { cwd }) })
```

(the spread is last so Biome's `useSortedKeys` sees an alphabetical named group; `exactOptionalPropertyTypes` forbids `cwd: undefined`);
replace every `rootId: activeRootId,` inside a `setTagged({ … })` call with `sessionKey,` (four sites: the create-failure branch, the ready branch, the exit branch, and the `.catch` branch); and replace the dependency array with

```ts
  }, [bridge, rootId, cwd, container, sessionId, toast]);
```

5. Replace the render-time derivation at the bottom:

```ts
  // Derive the displayed state during render (no effect mirror):
  //  - no bridge/root → idle;
  //  - a fresh outcome for the CURRENT session AND target → that outcome;
  //  - otherwise the session is still being set up → starting.
  let state: TerminalSessionState;
  if (!(bridge && rootId)) {
    state = { kind: 'idle' };
  } else if (tagged?.sessionId === sessionId && tagged.sessionKey === sessionKey) {
    state = tagged.outcome;
  } else {
    state = { kind: 'starting' };
  }
```

Also update the hook's doc comment: `Owns the imperative xterm Terminal + `window.terminal` pty session for ONE workspace root.` becomes `… for ONE checkout — the focused workspace root, or a pinned target inside it (`terminal-target-store`).`, and step 2 of the numbered lifecycle becomes ``bridge.create({ rootId, cwd, cols, rows })``.

- [ ] **Step 3 (GREEN): the panel resolves and releases the target**

`packages/app-shell/src/terminal-panel/terminal-panel.tsx`:

1. Add the import:

```ts
import { useTerminalTargetStore } from '../stores/terminal-target-store';
```

2. Replace `HumanTerminalProps` and the component's header:

```tsx
interface HumanTerminalProps {
  /** Pinned checkout path, or null when following the focused root. */
  readonly cwd: string | null;
  /** Present ONLY while a target is pinned — its absence IS "we follow focus". */
  readonly onClearTarget: (() => void) | undefined;
  readonly rootId: string;
}

function HumanTerminal({ cwd, onClearTarget, rootId }: HumanTerminalProps): ReactElement {
  const { containerRef, restart, state } = useTerminalSession(rootId, cwd);
```

3. In that component's header `<div>`, insert the release control before the existing Restart conditional, and widen the wrapper to hold both:

```tsx
        <div className="flex shrink-0 items-center gap-2">
          {onClearTarget ? (
            <Button
              data-testid="terminal-panel-clear-target"
              onClick={onClearTarget}
              size="sm"
              title="Stop pinning this terminal to a specific checkout"
              type="button"
              variant="outline"
            >
              Follow focused folder
            </Button>
          ) : null}
          {isExited || isError ? (
            <Button onClick={restart} size="sm" type="button" variant="outline">
              <RotateCw aria-hidden="true" className="mr-1" />
              Restart
            </Button>
          ) : null}
        </div>
```

4. In `TerminalPanel`, resolve the target and pass it down:

```tsx
export function TerminalPanel(): ReactElement {
  const focusedRootId = useActiveRootId();
  const target = useTerminalTargetStore((state) => state.target);
  const clearTarget = useTerminalTargetStore((state) => state.reset);
  const commandSessionsAvailable = useMemo(() => isCommandSessionBridgeAvailable(), []);
  const [surface, setSurface] = useState<'command-sessions' | 'shell'>('shell');
  // An explicit pin wins; with none the panel follows the focused root exactly
  // as it always has. Derived during render — never mirrored into state.
  const rootId = target?.rootId ?? focusedRootId;

  if (!rootId) {
```

and in the JSX:

```tsx
      <div className="min-h-0 flex-1" hidden={surface !== 'shell'}>
        <HumanTerminal
          cwd={target?.cwd ?? null}
          onClearTarget={target ? clearTarget : undefined}
          rootId={rootId}
        />
      </div>
      {commandSessionsAvailable ? (
        <div className="min-h-0 flex-1" hidden={surface !== 'command-sessions'}>
          <CommandSessionInventory key={rootId} rootId={rootId} />
        </div>
      ) : null}
```

5. Update the component doc comment's last paragraph:

```
 * Constructed only on desktop (the wrapper checks `window.terminal`); it still
 * renders its own no-root empty state. On a root focus-change the existing
 * session keeps running (it is pinned to its cwd); switching the active root
 * starts a fresh session for the newly focused root. A `terminal-target-store`
 * pin (BST-1457 "Open in Terminal") OVERRIDES the focused root and adds an
 * explicit "Follow focused folder" release, so a pin is visible and reversible
 * rather than a state the user cannot leave.
```

- [ ] **Step 4: verify**

```bash
pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/terminal-panel.test.tsx
pnpm --filter @brainstrike/app-shell run test
pnpm run type-check
pnpm run react-doctor
pnpm dlx ultracite fix packages/app-shell/src/terminal-panel/use-terminal-session.ts packages/app-shell/src/terminal-panel/terminal-panel.tsx packages/app-shell/src/__tests__/terminal-panel.test.tsx
```

- [ ] **Step 5: commit**

```bash
git commit -m "feat(BST-1457): the Terminal panel honors a pinned checkout target

useTerminalSession now takes (rootId, cwd) and keys its outcome-freshness
gate on the PAIR — the effect re-runs on a pin change without bumping
sessionId, so a rootId-only gate would leak the previous checkout's exited
overlay. The panel renders an explicit Follow focused folder release.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Layer 2 — the three surfaces

## Task 4: Worktree Map card action (and the tripwire deletion)

**Files:** `packages/app-shell/src/worktree-map/worktree-map-card.tsx`, `packages/app-shell/src/worktree-map/worktree-map-surface.tsx`, `packages/app-shell/src/worktree-map/__tests__/worktree-map-surface.test.tsx`

- [ ] **Step 1: DELETE the tripwire**

In `packages/app-shell/src/worktree-map/__tests__/worktree-map-surface.test.tsx`, delete the entire final test **and its preceding comment block** — from the line `  // TRIPWIRE (coordinator ruling, 2026-08-26). W3's A6 ruling deferred the` through the closing `  });` of `it('offers no "Open in Terminal" action anywhere on a card (W6 owns the seam)', …)`. This is the deletion its own comment mandates ("When W6 lands the terminal seam, this test is DELETED in that PR, not weakened here"), and it happens in the SAME commit as the replacement tests below.

Also update the surviving reference in the sibling test's comment (`// … Role-absent, matching the "Open in Terminal" // tripwire idiom below — not disabled, not present in any form.`) to name a live example instead:

```ts
  // (bot review fix, PR #2664) The service unconditionally refuses adopting
  // a repository's primary checkout, so offering Adopt on a primary card was
  // a guaranteed error. Role-absent — not disabled, not present in any form;
  // the same idiom the Add-as-root/Open-in-Terminal complementary pair uses
  // below (BST-1457 replaced the old W6 tripwire this used to point at).
```

- [ ] **Step 2 (RED): the replacement tests**

Add to the same `describe` block, and extend the file's mock header with the terminal seam. Add near the other `vi.mock` calls:

```ts
const openTerminalAtMock = vi.fn();
vi.mock('../../stores/terminal-target-store', () => ({
  useTerminalTargetStore: Object.assign(
    (selector: (state: { openTerminalAt: unknown }) => unknown) =>
      selector({ openTerminalAt: openTerminalAtMock }),
    { getState: () => ({ openTerminalAt: openTerminalAtMock }) }
  ),
}));

let mockTerminalAvailable = true;
vi.mock('../../terminal-panel/terminal-bridge', () => ({
  isTerminalBridgeAvailable: () => mockTerminalAvailable,
}));
```

Add `openTerminalAtMock` to the `beforeEach` reset loop and `mockTerminalAvailable = true;` to the `beforeEach` body. Then the cases:

```ts
  it('opens the pinned terminal for a card that is inside an open folder', async () => {
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /open in terminal/iu }));

    expect(openTerminalAtMock).toHaveBeenCalledExactlyOnceWith({
      cwd: '/wt',
      rootId: 'root-1',
    });
    // Falsifier: opening a terminal is not a ledger mutation and not a mount.
    expect(adoptMock).not.toHaveBeenCalled();
    expect(archiveMock).not.toHaveBeenCalled();
    expect(addRootDirectoryByPathMock).not.toHaveBeenCalled();
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it('offers Add as root instead of Open in Terminal for a checkout outside every open folder', async () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [card({ entry: { ...card().entry, rootId: null } })],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    // Complementary, never both, never a disabled stub: the menu always names
    // the next step.
    expect(screen.getByRole('menuitem', { name: /add as root/iu })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /terminal/iu })).not.toBeInTheDocument();
  });

  it('omits Open in Terminal entirely when the platform has no terminal bridge', async () => {
    mockTerminalAvailable = false;
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    // Capability gating by omission (spec §12): web renders no item, not a
    // disabled one. Reveal still renders, proving the menu itself is fine.
    expect(screen.queryByRole('menuitem', { name: /terminal/iu })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /reveal/iu })).toBeInTheDocument();
  });
```

```bash
pnpm --filter @brainstrike/app-shell exec vitest run src/worktree-map/__tests__/worktree-map-surface.test.tsx
```

- [ ] **Step 3 (GREEN): the card**

`packages/app-shell/src/worktree-map/worktree-map-card.tsx`:

1. Add `TerminalSquare` to the `lucide-react` import (alphabetical: `import { MoreHorizontal, TerminalSquare } from 'lucide-react';`).
2. Add to `WorktreeMapCardProps`, alphabetically between `onOpenPullRequest` and `onOpenThread`:

```ts
  /**
   * Present only when the platform HAS a terminal bridge (desktop). Absent on
   * web, where the item must not exist in any form.
   */
  readonly onOpenTerminal: ((card: WorktreeMapCardModel) => void) | undefined;
```

3. Destructure `onOpenTerminal` in the component's parameter list (alphabetical).
4. Replace the trailing comment block inside `<DropdownMenuContent>` (the `NO "Open in Terminal" ITEM.` note) with the real item, placed immediately BEFORE the `Reveal` item so the menu reads in spec §10's order:

```tsx
            {/*
              Complementary with "Add as root" above, never both: a checkout
              with no containing root has nothing to authorize a shell, and
              "Add as root" IS the stated next step. `entry.rootId` is the
              CONTAINING root (see `rootIdIsExactMount` in
              packages/types/src/worktree.ts) while `entry.path` is the
              checkout itself — main pins the shell to the path after a
              containment check, which is why both travel.
            */}
            {onOpenTerminal && entry.rootId ? (
              <DropdownMenuItem
                data-testid="worktree-map-open-terminal"
                onSelect={() => onOpenTerminal(card)}
              >
                <TerminalSquare aria-hidden="true" className="size-3.5" />
                Open in Terminal
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onReveal(entry.path)}>Reveal</DropdownMenuItem>
```

- [ ] **Step 4 (GREEN): the surface**

`packages/app-shell/src/worktree-map/worktree-map-surface.tsx`:

1. Add imports:

```ts
import { useTerminalTargetStore } from '../stores/terminal-target-store';
import { isTerminalBridgeAvailable } from '../terminal-panel/terminal-bridge';
```

`terminal-bridge` — NOT the `terminal-panel` barrel: the barrel re-exports `TerminalPanel`, which imports `@xterm/xterm`, and pulling that into the Map would defeat the panel's lazy code-split.

2. Alongside the other resolutions near `const platform = useMemo(…)`:

```ts
  // The capability IS the gate — resolved once, not per render, exactly like
  // the platform bridge above. Web has no `window.terminal`, so no item exists.
  const terminalAvailable = useMemo(() => isTerminalBridgeAvailable(), []);
  const openTerminalAt = useTerminalTargetStore((state) => state.openTerminalAt);
```

3. Add the callback beside `onAddAsRoot`:

```ts
  const onOpenTerminal = useCallback(
    (card: WorktreeMapCardModel) => {
      const { name, path, rootId } = card.entry;
      if (!rootId) {
        // The card renders this item only when `rootId` is non-null, so
        // reaching here is a wiring bug worth stating, never a silent no-op.
        setActionError(`"${name}" is not inside an open folder, so it has no terminal to open.`);
        return;
      }
      setActionError(null);
      openTerminalAt({ cwd: path, rootId });
    },
    [openTerminalAt]
  );
```

4. In the `<WorktreeMapCard …>` JSX, add the prop (alphabetical, between `onOpenPullRequest` and `onOpenThread`):

```tsx
                onOpenTerminal={terminalAvailable ? onOpenTerminal : undefined}
```

- [ ] **Step 5: verify**

```bash
pnpm --filter @brainstrike/app-shell run test
pnpm run type-check
# corrected at execution (Task 3 review, 2026-08-27): the bare `pnpm run
# react-doctor` script pins --scope full (repo-wide; always non-zero on
# pre-existing baseline debt, not a signal about THIS task's diff). Use the
# CI-equivalent scoped form instead, comparing against the commit the
# PREVIOUS task landed on:
npx react-doctor . --scope changed --base <previous-task-sha> --verbose -y
pnpm dlx ultracite fix packages/app-shell/src/worktree-map/worktree-map-card.tsx packages/app-shell/src/worktree-map/worktree-map-surface.tsx packages/app-shell/src/worktree-map/__tests__/worktree-map-surface.test.tsx
```

Confirm the tripwire is gone and nothing else references it:

```bash
rg -n "W6 owns the seam|offers no \"Open in Terminal\"" packages apps docs
```

The only surviving hits must be in `docs/superpowers/plans/2026-08-26-w5-worktree-map-and-agent-tools.md` (a historical plan, not a live contract) — `docs/agents/changeset-diff.md` is rewritten in Task 8.

- [ ] **Step 6: commit**

```bash
git commit -m "feat(BST-1457): Open in Terminal on Worktree Map cards; delete the W5 tripwire

The absence-assertion test is deleted in the SAME change that adds the real
action, as its own comment instructs. The item is complementary with Add as
root (rootId non-null vs null), so the menu always names the next step and
never shows a disabled stub.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Mode chip action (and its absence-assertion deletion)

**Files:** `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx`, `packages/assistant-ui/src/workspace-bar/mode-chip.tsx`, `packages/assistant-ui/src/__tests__/mode-chip.test.tsx`, `packages/app-shell/src/hooks/use-worktree-mode.ts`, `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`, `packages/assistant-ui/src/__tests__/worktree-create-dialog.test.tsx`, `packages/app-shell/src/__tests__/use-workspace-bar-mode.test.ts`, `packages/app-shell/src/__tests__/use-worktree-mode-terminal.test.ts` (new — corrected at execution: the Step 4 harness pushed `use-worktree-mode.test.ts` over Biome's line-count ceiling, so the three new tests were split into this sibling file per the `use-worktree-mode-repository-setup-consent.test.ts` precedent)

**(corrected at execution: two additional `WorkspaceBarMode` literal sites enumerated by the compiler — defect #3; Files lists are floors, the compiler is the census. Making `onOpenTerminal` a required key on `WorkspaceBarMode` (Step 2) breaks type-check on every OTHER file that builds a full `WorkspaceBarMode` object literal, not only the ones this plan named. `rg -n "onOpenPicker" -g '*.ts' -g '*.tsx'` at review time surfaced two such literals outside the original Files list — `worktree-create-dialog.test.tsx`'s own `mode()` factory and `use-workspace-bar-mode.test.ts`'s own `mode()` factory (the latter fully mocks `useWorktreeMode`, so it needs only the type-completeness fix, not new behavioral coverage). Both get the identical one-line `onOpenTerminal: undefined,` insertion, alphabetical between `onOpenPicker` and `onReveal` — the same idiom those same factories already carry for `onArchive`/`onCreateBranchHere`/`onHandOffToLocal`/`onReveal`. This is the compiler-enumerated-literal-sites class (W5 Task 1's precedent: let the compiler enumerate, then fix every site). Ruled out as false alarms: `use-workspace-bar-mode.ts` (the production hook) only DELEGATES to `useWorktreeMode(...)` rather than building its own literal, so it inherits the wiring automatically; `worktree-create-dialog.tsx` (the production component) only CONSUMES `WorkspaceBarMode` as a prop, never constructs one.)**

- [ ] **Step 1 (RED): replace the absence assertion**

In `packages/assistant-ui/src/__tests__/mode-chip.test.tsx`:

1. Add `onOpenTerminal: undefined,` to the `mode()` factory literal (alphabetical, between `onOpenPicker` and `onReveal`) — `WorkspaceBarMode` gains a required key with an `undefined`-able value, matching the file's existing `onArchive`/`onCreateBranchHere`/`onHandOffToLocal` idiom.
2. In `'offers the in-worktree menu items ONLY when their handlers exist'`, replace the two-line tripwire

```ts
    // "Open in Terminal" is deferred to W6 — ABSENT, never a disabled stub.
    expect(screen.queryByTestId('workspace-bar-mode-open-terminal')).toBeNull();
```

with

```ts
    // Still absent HERE, for the ordinary handler-presence reason this test
    // exists to pin (no onOpenTerminal in this render) — not because the
    // capability is deferred. BST-1457 landed the action; the case below
    // proves it renders and fires when the handler IS supplied.
    expect(screen.queryByTestId('workspace-bar-mode-open-terminal')).toBeNull();
```

3. Add the positive case:

```ts
  it('renders Open in Terminal only when its handler exists and wires it to that handler alone', async () => {
    const user = setup();
    const onOpenTerminal = vi.fn<() => void>();
    const value = interactiveWorktreeMode();
    render(<WorkspaceBar {...baseBarProps} mode={{ ...value.mode, onOpenTerminal }} />);

    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-open-terminal'));

    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    expect(value.onReveal).not.toHaveBeenCalled();
    expect(value.onArchive).not.toHaveBeenCalled();
    expect(value.onHandOffToLocal).not.toHaveBeenCalled();
    expect(value.onOpenPicker).not.toHaveBeenCalled();
  });
```

```bash
pnpm --filter @brainstrike/assistant-ui exec vitest run src/__tests__/mode-chip.test.tsx
```

- [ ] **Step 2 (GREEN): the prop and the item**

`packages/assistant-ui/src/workspace-bar/workspace-bar.tsx` — add to `WorkspaceBarMode`, alphabetically between `onOpenPicker` and `onReveal`:

```ts
  /**
   * Opens the app's Terminal on this worktree's checkout. Present only when the
   * platform has a terminal bridge AND the checkout resolves inside an open
   * folder — absent otherwise, never a disabled row.
   */
  readonly onOpenTerminal: (() => void) | undefined;
```

`packages/assistant-ui/src/workspace-bar/mode-chip.tsx`:

1. Add `TerminalSquare` to the `lucide-react` import (alphabetical after `Plus`).
2. In `WorktreeActions`, insert between the `onCreateBranchHere` block and the `onReveal` block (spec §4.3 order: Hand off · Create branch here · Open in Terminal · Reveal · Archive):

```tsx
    {mode.onOpenTerminal ? (
      <DropdownMenuItem
        data-testid="workspace-bar-mode-open-terminal"
        onSelect={mode.onOpenTerminal}
      >
        <TerminalSquare aria-hidden="true" className="size-3.5" />
        Open in Terminal
      </DropdownMenuItem>
    ) : null}
```

Note it is NOT `disabled={mode.pending}`: opening a shell reads nothing the in-flight worktree mutation owns, and blocking it during a slow archive would be a stall with no protective value. `Reveal` above it is already unguarded for the same reason.

- [ ] **Step 3 (GREEN): app-shell wiring**

`packages/app-shell/src/hooks/use-worktree-mode.ts`:

1. Add imports:

```ts
import { useTerminalTargetStore } from '../stores/terminal-target-store';
import { isTerminalBridgeAvailable } from '../terminal-panel/terminal-bridge';
```

2. Beside the existing `platform` resolution in the hook body:

```ts
  const terminalAvailable = useMemo(() => isTerminalBridgeAvailable(), []);
```

3. Inside the final `useMemo` callback, immediately after the `if (!(bridge && args.primaryRootId)) { return; }` guard:

```ts
    // `currentEntry.rootId` is the root that CONTAINS this worktree (the
    // managed-directory mount for a chip-created one, the parent repo for a
    // nested external one) while `currentEntry.path` is the checkout itself.
    // Captured into a local const so the closure below needs no re-narrowing.
    const terminalTarget =
      terminalAvailable && currentEntry?.rootId
        ? { cwd: currentEntry.path, rootId: currentEntry.rootId }
        : null;
```

4. Add `onOpenTerminal: undefined,` to the `!args.isRepository` early-return object (alphabetical, between `onOpenPicker` and `onReveal`).
5. Add to the main return object, same alphabetical slot:

```ts
      onOpenTerminal: terminalTarget
        ? () => {
            useTerminalTargetStore.getState().openTerminalAt(terminalTarget);
          }
        : undefined,
```

6. Add `terminalAvailable` to the `useMemo` dependency array (alphabetical; `currentEntry` is already a dep).

- [ ] **Step 4 (RED→GREEN): pin the wiring**

**(corrected at execution: plan defect #2. The file mocks none of the three seams — `platform-bridge`, `terminal-panel/terminal-bridge`, `stores/terminal-target-store` — `rg -n "showItemInFolder|platform-bridge|resolvePlatformBridge|isTerminalBridgeAvailable|terminal-bridge|terminal-target-store" packages/app-shell/src/__tests__/use-worktree-mode.test.ts` returned zero hits at review time, so the original snippet's `showItemInFolderMock` was phantom and `isTerminalBridgeAvailable` would have resolved `terminalAvailable` to `false` in every case, silently failing the positive test. Harness added below per the Task 4 `worktree-map-surface.test.tsx` mock pattern, adapted to the `.getState()`-only call form `use-worktree-mode.ts` actually uses; the phantom assertion is dropped; a third case pins the capability gate itself, which the original two tests could never have observed failing.)**

Add near the file's other `vi.hoisted`/`vi.mock` declarations, ABOVE the `import { useWorktreeMode } from '../hooks/use-worktree-mode';` line:

```ts
const { isTerminalBridgeAvailableMock, openTerminalAtMock } = vi.hoisted(() => ({
  isTerminalBridgeAvailableMock: vi.fn(() => true),
  openTerminalAtMock: vi.fn(),
}));

vi.mock('../terminal-panel/terminal-bridge', () => ({
  isTerminalBridgeAvailable: isTerminalBridgeAvailableMock,
}));
vi.mock('../stores/terminal-target-store', () => ({
  useTerminalTargetStore: {
    getState: () => ({ openTerminalAt: openTerminalAtMock }),
  },
}));
```

`isTerminalBridgeAvailableMock` defaults `true` (its base implementation, set once — `beforeEach`'s `vi.clearAllMocks()` clears call history, not the base implementation), so every existing test in the file is unaffected; only the new negative case below overrides it, and only for that one call (`mockReturnValueOnce`).

Add the three new cases, using the file's own `entry()` fixture helper (default `id: 'w-1'` already matches `WORKTREE_CHECKOUT.worktreeId`) rather than inventing a new literal:

```ts
  it('supplies onOpenTerminal with the checkout path and its containing root', async () => {
    // A nested worktree: `path` is the checkout itself, `rootId` is the
    // CONTAINING root — the two are DISTINCT values on purpose (Task 4's
    // falsifier: passing the root as cwd must fail this assertion).
    const nested = entry({
      path: '/repo/.claude/worktrees/bright-fox',
      rootId: 'root-1',
      rootIdIsExactMount: false,
    });
    listSpy.mockResolvedValue({ ok: true, value: [nested] });
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
    act(() => result.current?.onOpenPicker());
    await waitFor(() => expect(result.current?.onOpenTerminal).toEqual(expect.any(Function)));

    result.current?.onOpenTerminal?.();

    expect(openTerminalAtMock).toHaveBeenCalledExactlyOnceWith({
      cwd: '/repo/.claude/worktrees/bright-fox',
      rootId: 'root-1',
    });
    // Falsifiers: opening a terminal touches neither archive nor create.
    expect(archiveSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('omits onOpenTerminal when the checkout has no containing root', async () => {
    const noRoot = entry({
      path: '/repo/.claude/worktrees/bright-fox',
      rootId: null,
      rootIdIsExactMount: false,
    });
    listSpy.mockResolvedValue({ ok: true, value: [noRoot] });
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
    act(() => result.current?.onOpenPicker());
    // `worktree` becomes non-null exactly when `currentEntry` resolves
    // (id match), independent of rootId — the general "entries loaded"
    // signal this negative case needs, since onOpenTerminal never fires.
    await waitFor(() => expect(result.current?.worktree).not.toBeNull());

    expect(result.current?.onOpenTerminal).toBeUndefined();
    expect(openTerminalAtMock).not.toHaveBeenCalled();
  });

  it('omits onOpenTerminal when the terminal bridge is unavailable even with a valid containing root', async () => {
    // Pins the capability gate itself: a valid rootId alone must not be
    // enough. The original two-case plan could never have observed this
    // failing, since it never varied bridge availability.
    isTerminalBridgeAvailableMock.mockReturnValueOnce(false);
    const nested = entry({
      path: '/repo/.claude/worktrees/bright-fox',
      rootId: 'root-1',
      rootIdIsExactMount: false,
    });
    listSpy.mockResolvedValue({ ok: true, value: [nested] });
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
    act(() => result.current?.onOpenPicker());
    await waitFor(() => expect(result.current?.worktree).not.toBeNull());

    expect(result.current?.onOpenTerminal).toBeUndefined();
    expect(openTerminalAtMock).not.toHaveBeenCalled();
  });
```

> **Execution note (superseded in part, kept for provenance):** the arrange-block citation below is still accurate for the general fixture SHAPE (the `entry()` helper, `ARGS`, `WORKTREE_CHECKOUT`, and the `renderHook`/`onOpenPicker`/`waitFor` flow) — read `'wires createBranchHere only for the current managed detached worktree'` (~:716 — verified to exist) if the harness above needs adapting to a repo drift. The exact code above is no longer deferred; it was corrected and verified at execution (defect #2).

- [ ] **Step 5: verify**

```bash
pnpm --filter @brainstrike/assistant-ui run test
pnpm --filter @brainstrike/app-shell run test
pnpm run type-check
# corrected at execution (Task 3 review, 2026-08-27): the bare `pnpm run
# react-doctor` script pins --scope full (repo-wide; always non-zero on
# pre-existing baseline debt, not a signal about THIS task's diff). Use the
# CI-equivalent scoped form instead, comparing against the commit the
# PREVIOUS task landed on:
npx react-doctor . --scope changed --base <previous-task-sha> --verbose -y
pnpm dlx ultracite fix packages/assistant-ui/src/workspace-bar/workspace-bar.tsx packages/assistant-ui/src/workspace-bar/mode-chip.tsx packages/assistant-ui/src/__tests__/mode-chip.test.tsx packages/app-shell/src/hooks/use-worktree-mode.ts
pnpm exec biome check packages/app-shell/src/hooks/use-worktree-mode.ts
```

- [ ] **Step 6: commit**

```bash
git commit -m "feat(BST-1457): Open in Terminal on the Mode chip's worktree menu

The W3-era ABSENT assertion in mode-chip.test.tsx is replaced by a positive
handler-wiring case. app-shell supplies the handler only when the terminal
bridge exists and the checkout resolves inside an open folder.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Folder chip root-row action

**Files:** `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx`, `packages/assistant-ui/src/workspace-bar/folder-chip.tsx`, `packages/assistant-ui/src/__tests__/workspace-bar.test.tsx`, `packages/app-shell/src/hooks/use-workspace-bar.ts`, `packages/app-shell/src/hooks/use-workspace-bar-terminal.ts` (new — corrected at execution: the pre-authorized remedy for Step 4's line-count contingency fired instead for `noExcessiveCognitiveComplexity`; same extraction applied)

- [ ] **Step 1 (RED): pin the row action**

Add to `packages/assistant-ui/src/__tests__/workspace-bar.test.tsx` (the file's `baseProps`, `setup`, `openFolderMenu` and `openRootSubmenu` helpers are already in scope):

```ts
  it('offers Open in Terminal on a root row and passes its rootId and path', async () => {
    const user = setup();
    const onOpenTerminal = vi.fn<(rootId: string, path: string) => void>();
    const onCopyPath = vi.fn<(path: string) => void>();
    render(<WorkspaceBar {...baseProps({ onCopyPath, onOpenTerminal })} />);

    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-main');
    await user.click(await screen.findByTestId('workspace-bar-open-terminal-r-main'));

    expect(onOpenTerminal).toHaveBeenCalledExactlyOnceWith('r-main', '/ws/brainstrike');
    expect(onCopyPath).not.toHaveBeenCalled();
  });

  it('omits Open in Terminal when the platform supplies no handler', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseProps()} />);

    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-main');

    expect(screen.queryByTestId('workspace-bar-open-terminal-r-main')).not.toBeInTheDocument();
  });

  it('omits Open in Terminal for a root with no filesystem path (web FSA root)', async () => {
    const user = setup();
    const onOpenTerminal = vi.fn<(rootId: string, path: string) => void>();
    render(
      <WorkspaceBar
        {...baseProps({
          onOpenTerminal,
          primaryRoot: { displayName: 'granted', rootId: 'r-fsa' },
        })}
      />
    );

    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-fsa');

    // A path-less root cannot be a shell cwd; the row still renders its other
    // actions rather than the whole submenu vanishing.
    expect(screen.queryByTestId('workspace-bar-open-terminal-r-fsa')).not.toBeInTheDocument();
  });
```

```bash
pnpm --filter @brainstrike/assistant-ui exec vitest run src/__tests__/workspace-bar.test.tsx
```

- [ ] **Step 2 (GREEN): the prop and the action**

`packages/assistant-ui/src/workspace-bar/workspace-bar.tsx` — add to `WorkspaceBarProps`, alphabetically between `onMakePrimary` and `onRemoveSecondary`:

```ts
  /**
   * Opens the app's Terminal on a mounted root. Present only when the platform
   * has a terminal bridge (desktop). `rootId` authorizes and `path` is where
   * the shell actually starts — main containment-checks the second against the
   * first, so both travel together.
   */
  readonly onOpenTerminal?: ((rootId: string, path: string) => void) | undefined;
```

`packages/assistant-ui/src/workspace-bar/folder-chip.tsx`:

1. Add `TerminalSquare` to the `lucide-react` import (alphabetical, after `Star`).
2. Widen `rootActions`' `handlers` pick and add the action inside the existing `if (path) { … }` block, after the `reveal` push and before the `onCopyPath` push (so the menu reads Reveal · Open in Terminal · Copy path):

```ts
function rootActions(
  root: WorkspaceBarRoot,
  isPrimary: boolean,
  handlers: Pick<
    FolderChipProps,
    'onCopyPath' | 'onMakePrimary' | 'onOpenTerminal' | 'onRemoveSecondary' | 'reveal'
  >
): readonly RootAction[] {
```

```ts
    const { onCopyPath, onOpenTerminal, reveal } = handlers;
```

```ts
    if (onOpenTerminal) {
      actions.push({
        disabledReason: null,
        icon: TerminalSquare,
        label: 'Open in Terminal',
        onSelect: () => onOpenTerminal(root.rootId, path),
        testId: `workspace-bar-open-terminal-${root.rootId}`,
      });
    }
```

Both guards matter: the action lives INSIDE `if (path)` (a web FSA root has no `path`, so no shell cwd exists) and behind `onOpenTerminal` (no bridge, no item).

3. Add `onOpenTerminal` to the `FolderChip` destructured parameter list (alphabetical), to the `RootRow` `Pick<…>` union, and to the `rootHandlers` object:

```ts
  const rootHandlers = { onCopyPath, onMakePrimary, onOpenTerminal, onRemoveSecondary, reveal };
```

- [ ] **Step 3 (GREEN): app-shell wiring**

`packages/app-shell/src/hooks/use-workspace-bar.ts`:

1. Add imports:

```ts
import { useTerminalTargetStore } from '../stores/terminal-target-store';
import { isTerminalBridgeAvailable } from '../terminal-panel/terminal-bridge';
```

2. Immediately after the `onCopyPath` callback:

```ts
  // Resolved ONCE, like `platform` above — the capability IS the gate, so web
  // omits the affordance rather than rendering a dead row. A mounted root is
  // its own cwd, so `rootId` and `path` name the same folder here; both still
  // travel because main authorizes on the first and spawns in the second.
  const terminalAvailable = useMemo(() => isTerminalBridgeAvailable(), []);
  const onOpenTerminal = useCallback((rootId: string, path: string) => {
    useTerminalTargetStore.getState().openTerminalAt({ cwd: path, rootId });
  }, []);
```

3. In the returned object, alphabetically after `onMakePrimary`:

```ts
    ...(terminalAvailable ? { onOpenTerminal } : {}),
```

- [ ] **Step 4: verify**

```bash
pnpm --filter @brainstrike/assistant-ui run test
pnpm --filter @brainstrike/app-shell run test
pnpm run type-check
# corrected at execution (Task 3 review, 2026-08-27): the bare `pnpm run
# react-doctor` script pins --scope full (repo-wide; always non-zero on
# pre-existing baseline debt, not a signal about THIS task's diff). Use the
# CI-equivalent scoped form instead, comparing against the commit the
# PREVIOUS task landed on:
npx react-doctor . --scope changed --base <previous-task-sha> --verbose -y
pnpm dlx ultracite fix packages/assistant-ui/src/workspace-bar/workspace-bar.tsx packages/assistant-ui/src/workspace-bar/folder-chip.tsx packages/assistant-ui/src/__tests__/workspace-bar.test.tsx packages/app-shell/src/hooks/use-workspace-bar.ts packages/app-shell/src/hooks/use-workspace-bar-terminal.ts
# Verified during planning: the 1000-line cap counts CODE lines, and this file
# sits at ~749. Run the check anyway — if it fires, extract the terminal
# wiring into packages/app-shell/src/hooks/use-workspace-bar-terminal.ts and
# call it from here. Never register a Biome override.
# (Corrected at execution, 2026-08-27: it was noExcessiveCognitiveComplexity
# — 21 vs max 20 — that fired, not the anticipated noExcessiveLinesPerFile;
# the line count stayed fine. Same remedy applied regardless — the extracted
# hook returns a ready-to-spread partial, per the checkoutEntry/forgeEntry/
# modeEntry idiom already in this file, so the call site carries no
# conditional of its own and the calling hook's complexity budget stays
# untouched by this wiring.)
pnpm exec biome check packages/app-shell/src/hooks/use-workspace-bar.ts
```

- [ ] **Step 5: commit**

```bash
git commit -m "feat(BST-1457): Open in Terminal on the workspace bar's folder rows

Closes spec §4.1's desktop-only trio (Reveal, Open in Terminal, Copy path).
Double-gated: inside the path branch (a web FSA root has no shell cwd) and
behind the handler (no bridge, no item).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Layer 3 — verification

## Task 7: desktop E2E

**Files:** `apps/desktop/e2e/worktree-map.desktop.test.ts`, `apps/desktop/e2e/terminal-panel.desktop.test.ts`

Both files are already in `apps/desktop/package.json`'s `test:e2e:lane:smoke` list — **do not add a lane entry, and do not tag either new case `@smoke`** (the smoke lane greps `@smoke` and has a 300 s global timeout; these are full-regression cases).

- [ ] **Step 1: the nested-worktree fixture and case in the Map suite**

Add a local fixture helper to `apps/desktop/e2e/worktree-map.desktop.test.ts`, beside `freshRepoWithManagedExternalWorktree`:

```ts
/**
 * A repo with a worktree NESTED INSIDE it, at the `.claude/worktrees/<name>`
 * path every external tool uses. This is the topology `terminal:create`'s `cwd`
 * parameter exists for: the nested checkout's `WorktreeListEntry.rootId` is the
 * PARENT repo's root (it is merely CONTAINED, `rootIdIsExactMount: false`), so
 * a terminal pinned to `rootId` alone would open in the parent repo. Verified
 * on disk during planning: `git worktree add` into a path under the repo works
 * and `git worktree list --porcelain` enumerates it.
 */
function freshRepoWithNestedWorktree(label: string): WorktreeMapRepoFixture {
  const repo = freshGitRepo({ label, prefix: 'bst-w6-map-', tracker: tempDirs });
  const worktree = path.join(repo, '.claude', 'worktrees', `${label}-nested`);
  git(repo, ['worktree', 'add', '-b', `${label}/nested`, worktree, 'HEAD']);
  return { repo, worktree };
}
```

Add the case inside `test.describe('Worktree Map (desktop)', …)`, after the adoption case:

```ts
  test('Open in Terminal pins the shell to the NESTED checkout, not the parent repo', async ({
    window: page,
  }) => {
    test.setTimeout(240_000);
    const { repo, worktree } = freshRepoWithNestedWorktree('terminal');
    await seedRoot(page, repo);
    await openWorktreeMap(page);

    const cards = page.getByTestId('worktree-map-card');
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    const nestedCard = cards.filter({ hasText: path.basename(worktree) });
    await nestedCard.getByTestId('worktree-map-card-actions').click();
    await page
      .getByRole('menu')
      .getByRole('menuitem', { exact: true, name: 'Open in Terminal' })
      .click();

    // The Terminal app tab opened itself (no '+' menu click) and the panel's
    // header reports the cwd MAIN resolved — the assertion that fails if the
    // shell landed in the parent repo instead.
    await expect(page.getByTestId('terminal-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('terminal-panel')).toContainText(path.basename(worktree), {
      timeout: 60_000,
    });
    await expect(page.getByTestId('terminal-panel-clear-target')).toBeVisible();

    // And it is a REAL shell in that directory, not just a label: `pwd` is the
    // falsifier a header-only assertion cannot provide.
    await page.getByTestId('terminal-host').click();
    await page.keyboard.type('pwd\r');
    await expect(page.locator('.xterm-rows')).toContainText(path.basename(worktree), {
      timeout: 30_000,
    });
  });
```

- [ ] **Step 2: the release case in the Terminal suite**

Add to `test.describe('Terminal panel (desktop)', …)` in `apps/desktop/e2e/terminal-panel.desktop.test.ts`:

```ts
  test('has no pin control when opened from the workspace + menu', async ({ window: page }) => {
    test.setTimeout(90_000);
    const dir = freshRootDir('unpinned');
    await seedRoot(page, dir);
    await openTerminalPanel(page);
    await waitForShellReady(page, dir);

    // Opened WITHOUT a target: the panel follows the focused root, so the
    // release control must not exist (absence is the contract, not a disabled
    // button).
    await expect(page.getByTestId('terminal-panel-clear-target')).toHaveCount(0);
  });
```

- [ ] **Step 3: run**

```bash
pnpm --filter @brainstrike/desktop run build
pnpm --filter @brainstrike/desktop exec playwright test e2e/worktree-map.desktop.test.ts e2e/terminal-panel.desktop.test.ts --workers=1 --retries=0
```

Desktop E2E can be flaky headless — **diagnose, never bypass**. If the nested card's name collides with the primary's, scope by the branch label (`nested`) instead of the basename.

- [ ] **Step 4: commit**

```bash
git commit -m "test(BST-1457): desktop e2e for Open in Terminal on a nested checkout

The nested `.claude/worktrees/<name>` fixture is the case the cwd parameter
exists for: the entry's rootId is the PARENT repo, so a `pwd` in the spawned
shell is the assertion that fails if the shell landed in the wrong repository.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: CDT probe and living docs

**Files:** `scripts/probe-worktree-map.mjs`, `docs/agents/changeset-diff.md`, `docs/agents/workspace-context.md`

- [ ] **Step 1: add the `open-terminal` probe**

`scripts/probe-worktree-map.mjs` — add to the `probes` object (Biome keeps the literal alphabetical, so it lands between `map-cards` and `narrow-pane`; the RUN_ORDER parity check below is what actually orders it):

```js
  /** BST-1457 Step 1 — Open in Terminal pins the panel to the card's checkout.
   * Requires --repo. Uses the PRIMARY card, which always has a `rootId` (it is
   * the seeded workspace root), so the probe never depends on an adoption
   * having happened first. Reports COMPUTED VALUES: whether the item exists,
   * the panel's rendered header text, and the release control's rect. */
  async 'open-terminal'(page) {
    await seedRootByPath(page, repoPath);
    await openWorktreeMapTab(page);

    const primaryCard = page.locator('[data-testid="worktree-map-card"]').first();
    await primaryCard.getByTestId('worktree-map-card-actions').click();
    const item = page.getByRole('menuitem', { exact: true, name: 'Open in Terminal' });
    const itemCount = await item.count();
    record('open-terminal.item-present', { itemCount }, (v) => v.itemCount === 1);
    if (itemCount !== 1) {
      await page.keyboard.press('Escape');
      return;
    }
    await item.click();

    await page.waitForSelector('[data-testid="terminal-panel"]', { timeout: 30_000 });
    const panel = await read(page, '[data-testid="terminal-panel"]');
    const expectedBasename = repoPath.split('/').filter(Boolean).at(-1) ?? null;
    record(
      'open-terminal.panel-shows-checkout-cwd',
      { expectedBasename, text: panel?.text ?? null },
      // An unresolvable basename FAILS the check; it never falls back to a
      // sentinel that could make an empty panel read as a pass.
      (v) => v.expectedBasename !== null && (v.text ?? '').includes(v.expectedBasename)
    );

    const release = await read(page, '[data-testid="terminal-panel-clear-target"]');
    record(
      'open-terminal.release-control-is-real',
      release,
      (v) => v !== null && v.disabled === false && v.width > 0 && v.height > 0
    );

    await page.click('[data-testid="terminal-panel-clear-target"]');
    const afterRelease = await read(page, '[data-testid="terminal-panel-clear-target"]');
    record('open-terminal.release-clears-the-pin', { afterRelease }, (v) => v.afterRelease === null);
  },
```

and add `'open-terminal'` to `RUN_ORDER` (after `'narrow-pane'`, before `'pr-pill'`). The script's own parity check (`[...RUN_ORDER].sort().join(',') !== Object.keys(probes).sort().join(',')` ⇒ `exit 2`) makes a one-sided edit a hard failure, so both edits must land together. `open-terminal` needs `--repo`, so it is NOT added to `REPO_EXEMPT_PROBES`.

- [ ] **Step 2: run it live**

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug   # separate shell; CDP on 127.0.0.1:9222
node scripts/probe-worktree-map.mjs --probe open-terminal --repo <path-to-a-real-git-repo>
```

Paste the JSON (`failures`, `results`, `skipped`) into the PR body. `failures: 0` **with `results` non-empty** is the pass condition — a run that executed no verification is not evidence.

- [ ] **Step 3: rewrite the A6 paragraph in `docs/agents/changeset-diff.md`**

Replace the paragraph beginning `**"Open in Terminal" is deferred to W6 — settled, do not relitigate.**` (through `…both are recorded here rather than living only in a review thread.`) with:

```md
**"Open in Terminal" — SHIPPED in W6 (BST-1457); the deferral and its tripwire
are gone.** Spec §10 lists the action on a Worktree Map card, §4.1 on the Folder
chip's root rows and §4.3 on the Mode chip's worktree menu; all three exist. The
seam is the app's OWN Terminal workspace app, not the OS terminal emulator and
not `window.worktrees`: `worktrees` gains no `openInTerminal` member (spec §6.1
placed it there, but the action mutates nothing and needs no main-side worktree
state — recorded as W6 ruling T1), and an external emulator was rejected because
it would hand a shell to a path the app never containment-checked, with no
honest cross-platform story (T2).

Two pieces make it work. `terminal:create` accepts an optional `cwd` that is
realpath'd and SEPARATOR-ANCHORED containment-checked inside the already-
validated root (`resolveContainedCwd` in `apps/desktop/src/workspace-root-cwd.ts`);
omitted, behavior is byte-for-byte what it was. The parameter is not a
convenience: `WorktreeListEntry.rootId` is the first root CONTAINING a checkout,
not its own mount (`rootIdIsExactMount` is that flag), so a worktree nested at
`.claude/worktrees/<name>` under an open repo resolves to the PARENT's root id —
pinning the shell to `rootId` alone would silently open it in the wrong
repository. Every surface therefore passes BOTH `{ cwd: <checkout path>,
rootId: <containing root> }`. On the renderer side a session-lived
`terminal-target-store` (`packages/app-shell/src/stores/`) holds a STANDING pin;
`openTerminalAt` sets it, switches the shell route to `explorer` and opens the
Terminal app tab (it owns both halves, unlike `changes-navigation-store`, because
all three callers need the identical pair). `TerminalPanel` derives
`target ?? focused root` during render — never an effect mirror — and renders an
explicit "Follow focused folder" release so a pin is reversible rather than a
trap. `useTerminalSession`'s outcome-freshness gate keys on the (rootId, cwd)
PAIR: the lifecycle effect re-runs on a pin change without bumping `sessionId`,
so a rootId-only gate would leak the previous checkout's `exited` overlay onto
the freshly-starting one.

On a Map card the item renders exactly when `entry.rootId !== null`, and
`Add as root` renders exactly when it is `null` — complementary, so the menu
always names the next step and never shows a disabled action. Web has no
`window.terminal`, so `isTerminalBridgeAvailable()` is false and no surface
supplies the handler: the item does not exist there in any form. The W5
absence-assertion tripwire in
`packages/app-shell/src/worktree-map/__tests__/worktree-map-surface.test.tsx` and
the sibling assertion in `packages/assistant-ui/src/__tests__/mode-chip.test.tsx`
were DELETED in the same PR that added the action, as their own comments
instructed.

The A5 run-scoped `git worktree lock` deferral above still stands on its own —
it remains a capability the spec named that no seam yet supports.
```

- [ ] **Step 4: correct the terminal-cwd line in `docs/agents/workspace-context.md`**

In the **FOCUSED root** bullet, replace `Drives terminal cwd, selection scoping, …` with:

```md
- **FOCUSED root** = SELECTION state (`currentFolderId`). Drives the Terminal
  panel's DEFAULT cwd, selection scoping, and the selection write-back default
  (`resolveWriteBackTarget` untouched). It flips on any incidental click
  (`handleTreeInteraction` in `file-explorer-sidebar.tsx`), so it must NEVER
  drive hooks/model cwd. Surfaced visually, never described as the
  assistant's root.

**The Terminal's cwd is FOCUSED-by-default, PINNED-when-asked (BST-1457).**
`TerminalPanel` follows the focused root until a surface publishes a
`terminal-target-store` pin — "Open in Terminal" on a Worktree Map card, the
Mode chip's worktree menu, or a Folder chip root row. A pin carries
`{ cwd, rootId }` because the two differ for a nested checkout, survives focus
changes on purpose, and is released by the panel's own "Follow focused folder"
control or by factory reset. This is the ONE place a FOCUSED-root default is
deliberately overridable: unlike hooks/model cwd (which must never follow
focus), a terminal is something the user aims explicitly.
```

- [ ] **Step 5: verify and commit**

```bash
pnpm run lint:eslint
pnpm dlx ultracite fix scripts/probe-worktree-map.mjs
node scripts/probe-worktree-map.mjs --probe nope 2>&1; echo "exit=$?"   # must print exit=2
```

```bash
git commit -m "docs(BST-1457): record the shipped Open in Terminal contract; add the CDT probe

changeset-diff.md's A6 deferral paragraph is replaced by the shipped contract
(the terminal seam, the cwd containment rule, the complementary card items and
the tripwire deletions); workspace-context.md's FOCUSED-root line now says the
terminal cwd is focused-by-default and pinned-when-asked.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Definition of done

- [ ] `terminal:create` refuses a non-absolute, empty, missing, non-directory or out-of-root `cwd` and spawns nothing; a contained `cwd` reports the NESTED path.
- [ ] The two absence assertions are DELETED, and `rg -n "W6 owns the seam"` finds nothing outside historical plan documents.
- [ ] Open in Terminal renders on Map cards (`rootId !== null`), the Mode chip's worktree menu, and Folder chip root rows with a path — and on none of them when `window.terminal` is absent.
- [ ] The panel shows the pinned checkout's cwd, offers "Follow focused folder", and returns to the focused root when released.
- [ ] Desktop E2E proves `pwd` inside the spawned shell is the nested checkout, not the parent repo.
- [ ] `node scripts/probe-worktree-map.mjs --probe open-terminal --repo <repo>` reports `failures: 0` with non-empty `results`; JSON pasted into the PR.
- [ ] `pnpm run type-check`, `pnpm run lint:eslint`, `pnpm dlx ultracite check`, `npx react-doctor . --scope changed --base <previous-task-sha> --verbose -y` (corrected at execution, Task 3 review, 2026-08-27 — see the Global Constraints gate line above), and every touched package's `test` green **in one run**.
- [ ] `docs/agents/changeset-diff.md` and `docs/agents/workspace-context.md` updated in-band.

---

## Self-review (performed 2026-08-27, against `origin/integration/workspace-checkout-awareness` @ `3d54958160`)

**1. Spec coverage.** §4.1's Folder-chip trio (Reveal ✓ shipped, Copy path ✓ shipped, **Open in Terminal** ✓ Task 6). §4.3's Mode-chip menu ✓ Task 5. §10's Map card action ✓ Task 4 — the ONE §10 action W5 left unbuilt. §6.1's `openInTerminal` on `window.worktrees` — **deliberate stated deviation (T1)**, not an omission. §12 (web omits, never stubs) ✓ every surface. §13 (no silent fallbacks) ✓ Task 1's four refusal cases plus the complementary card items. §14 (unit + real-backend integration + desktop E2E + live CDT) ✓ Tasks 1, 4–8. §7's root context menu, §15's W6 row (File menu, drag-drop, argv) and "Remove from recents" are named out of scope with their reasons.

**2. Placeholder scan.** Every code block is complete and paste-ready except two harness-setup ellipses in Task 5 Step 4, which are flagged in-line as the plan's only deferrals and directed at `'wires createBranchHere only for the current managed detached worktree'` (~:716, VERIFIED to exist — corrected at plan review from a phantom "supplies onReveal" citation) in a file whose harness must be read at HEAD. No "similar to task N". No TODO.

**3. Symbol existence — every symbol verified by `git grep`/`git show` against the integration tip, not memory.** `resolveRootCwd`/`RootCwdResult`/`WorkspaceRootResolver` (`apps/desktop/src/workspace-root-cwd.ts`) ✓. `createTerminalIpcHandlers`, `TerminalCreateParams`, `disposeAllTerminals`, `liveTerminalCountForTest` ✓. `TERMINAL_CREATE_CHANNEL` and the preload `terminal` block ✓ (`preload.ts:159,1547`). `TerminalBridge`/`TERMINAL_BRIDGE_REQUIRED_METHOD_SET`/`isTerminalBridgeAvailable` ✓. `useActiveRootId`, `useTerminalSession`, `TerminalPanel`, `CommandSessionInventory`, `isCommandSessionBridgeAvailable` ✓. `useWorkspaceTabSelectionStore.openApp`, `TERMINAL_APP_ID` (`packages/file-explorer-ui/src/shell/workspace-app.ts:38`) ✓ — and the store subpath's existing re-export list (CANVAS/CHANGES/CONTEXT_EXPLORER only) is why Task 2 Step 2 exists. `usePanelLayoutStore.setActiveTab('explorer')` ✓ (`use-terminal-hotkey.ts`). `registerFactoryResetSessionStore` ✓. `WorktreeMapCardModel`, `WorktreeListEntry.rootId`/`rootIdIsExactMount`/`path`/`name` ✓. `WorkspaceBarMode.onReveal`/`onOpenPicker`, `WorkspaceBarProps.onCopyPath`, `WorkspaceBarRoot.path` ✓. `rootActions`/`RootAction`/`RootRow` ✓. e2e `freshRepo`, `git`, `createTempDirTracker`, `seedRoot`, `setupAssistantMock`, `startModelProviderShim`, `openTerminalPanel`, `waitForShellReady`, `freshRootDir` ✓. Probe `record`/`read`/`seedRootByPath`/`openWorktreeMapTab`/`RUN_ORDER`/`REPO_EXEMPT_PROBES` ✓.

**4. Type consistency.** `exactOptionalPropertyTypes: true` verified (`packages/config/tsconfig/base.json:22`) — every optional-property supply uses a trailing conditional spread, never `key: undefined`. `WorkspaceBarMode` uses required-key/undefined-value (matching `onArchive`); `WorkspaceBarProps` uses optional-key (matching `onCopyPath`) — both match their file's existing idiom rather than a single invented rule. `TerminalResult<T>` is conditional on `void`, so the tests build success envelopes via the existing `ok()` helper rather than the deferred generic. No `any` anywhere.

**5. Falsifiability audit.** Task 1's sibling-prefix case (`<root>-evil`) is the falsifier a naive `startsWith` containment check fails. Task 3's "previous target's outcome" case is the falsifier a `rootId`-only freshness gate fails. Task 4's terminal case asserts `adopt`/`archive`/`addRootDirectoryByPath`/`showItemInFolder` were NOT called. Task 5's asserts the four sibling mode handlers were not called. Task 7's `pwd` assertion is the falsifier that a header-label-only implementation (or a `rootId`-only `create` call) fails — a Map-card e2e that only checked the panel opened would pass on a wrong-cwd implementation. The CDT probe's `results`-non-empty pass condition closes the instrument-that-cannot-fail trap.

**6. Verified-by-execution, not assumed.** Nested `git worktree add` into `<repo>/.claude/worktrees/<name>` and its appearance in `git worktree list --porcelain` — run on disk. Biome's `noExcessiveLinesPerFile` counting CODE lines not physical lines (900 code + 200 comment = pass; 1200 code = fail) — run against the real config, which corrects the W5 plan's "physical lines" framing and removes a false split-the-file pressure on `use-workspace-bar.ts`. `pnpm exec biome check packages/app-shell/src/hooks/use-workspace-bar.ts` clean at 1041 physical lines — run.

**7. Ticket id (resolved at review).** The plan's original BST-1393 guess was wrong — that ticket is the broader low-friction-connection scope. The correct ticket is **BST-1457** (confirmed in Linear, filed 2026-08-27), and it matters beyond commit prefixes: seven citation sites live in shipped source and doc strings. All 18 sites now read BST-1457.
