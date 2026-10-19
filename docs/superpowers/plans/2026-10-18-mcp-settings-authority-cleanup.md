# MCP Settings Authority Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three follow-ups that PR #3953's last review triaged out of `McpSettingsAuthority`:
- the config file is too large to review;
- the file watcher stays off silently after a failed restart;
- an install that wrote the config but then failed to reload reports a plain failure.

**Architecture:**
- **Task 1** splits catalog install and token rollback out of `settings-authority.ts`, behind a narrow commit seam, and dedupes `errorMessage`. It changes no behavior.
- **Task 2** makes watcher health a visible, recoverable state instead of an operation error:
  - the authority remembers that the watcher is wanted;
  - every commit and every config read retries it;
  - while it is down, config status carries `watchError` and Settings shows it;
  - a watcher failure no longer fails a save or an install, and no longer skips the reload.
- **Task 3** words the remaining post-write failure (reload) as a partial success.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Effect Schema, React 19, Vitest + Testing Library.

**Context:** branch `claude/mcp-setup-linear-config-84b6aa` (PR #3953). Spec: `docs/superpowers/specs/2026-10-18-mcp-catalog-design.md`. These commits land on the same PR, as with the previous follow-ups.

## Global Constraints

- One authoritative writer: `McpSettingsAuthority` stays the single writer of the MCP config and its lifecycle. Extracted modules are helpers it calls; they never own `#trackOperation`, the epochs or the watcher.
- No silent fallback or degradation:
  - a watcher that cannot run is always visible in config status until it runs again;
  - every refusal and failure keeps its exact message below.
- TypeScript strict, no `any`, `exactOptionalPropertyTypes` (conditional spreads). Biome: sorted keys and props, block statements, at most 1000 code lines per file, at most 20 cognitive complexity per function.
- The MCP grammar comes only from `@brainstrike/assistant-contract/mcp-config` and the catalog only from `@brainstrike/assistant-contract/mcp-catalog`. Never print a token.
- Red first. Pure refactors (Task 1) keep every existing test green and unchanged, apart from import paths.
- One commit per task, conventional message, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Hooks run; never `--no-verify`. When a hook fails, confirm the errors reproduce on a direct run before calling them unrelated.
- Build changed packages before type-checking consumers: `node scripts/run-turbo-command.mjs -- run build '--filter=<pkg>'`.

---

### Task 1: Split catalog install out of the authority (no behavior change)

**Files:**
- Create: `packages/host-capabilities/src/mcp/catalog-install.ts`
- Modify: `packages/host-capabilities/src/mcp/settings-authority.ts`
- Modify: `packages/host-capabilities/src/mcp/config-sync.ts`
- Modify: `packages/host-capabilities/src/mcp/config-file.ts` (`errorMessage` export)

**Requirements:**
- Move the catalog install body (lookup and refusals, the read, the duplicate check, token creation, the JSONC append, and the rollback decision with its messages: today's `installCatalogServer` internals, `#commitInstallText` and `#removeUnwrittenToken`) into `catalog-install.ts`.
- The public method `McpSettingsAuthority.installCatalogServer` stays, with the same signature. It keeps the `#trackOperation` wrapper and delegates to the module through an injected seam, for example:
  ```ts
  installCatalogServerWith({ request, configFile, bearerCredentials, commit })
  ```
  where `commit(content, baseRevision, conflictMessage)` is the authority's own `#writeAndSync` bound to the current lifecycle epoch.
- The module imports nothing from `settings-authority.ts`.
- `errorMessage` has one definition. Export it from `config-file.ts`, the lowest layer, and import it in `config-sync.ts`, `settings-authority.ts` and `catalog-install.ts`. Delete the other copies.
- `settings-authority.ts` ends well under 900 physical lines. Report the before and after counts.
- Every existing test passes unchanged. Only imports may change; no assertion may change.
- Commit: `refactor(mcp): catalog install lives beside the settings authority, behind its commit seam`.

**Verify:**
- `pnpm --filter @brainstrike/host-capabilities exec vitest run __tests__/mcp-settings-authority.test.ts __tests__/mcp-settings-authority-catalog.test.ts __tests__/mcp-settings-authority-status.test.ts __tests__/mcp-settings-authority-preferences.test.ts __tests__/mcp-config-file.test.ts __tests__/mcp-config-file-comprehensive.test.ts __tests__/desktop-mcp-diagnostics.test.ts`
- `pnpm --filter @brainstrike/host-capabilities type-check`
- Biome on the touched files.

---

### Task 2: Watcher health is a visible, retried state

**Files:**
- Modify: `packages/host-capabilities/src/mcp/settings-authority.ts`, `config-sync.ts`, `config-status.ts`
- Modify: `packages/agent-host/src/protocol-mcp-settings.ts` (`McpConfigStatusSchema.watchError`) and `packages/agent-host/src/protocol.ts` (one sentence added to the v12 note)
- Modify: `packages/settings-ui/src/settings/tools/types.ts` (`McpConfigInfo.watchError?`), plus a new `packages/settings-ui/src/settings/tools/mcp-config-watch-notice.tsx` rendered from where the config status is already held (UnifiedToolsSettings, or the MCP Config tab)
- Modify: `apps/desktop/src/renderer/components/settings/page-content.tsx` if its config-status mapping picks fields explicitly
- Tests: the authority suites, the settings-ui suites, `page-content-operations.test.tsx`

**Exact behavior:**
- **State.** The authority holds:
  - `#watchWanted: boolean`, set true when it starts a watcher (`start()`, a config path change, creating the sample) and false on `close()`, reset and suspend;
  - `#watchError: string | null`.
  Resume after a reset or suspend restores it consistently with today's resume logic.
- **`#ensureWatcherForLifecycle(epoch)`.** If `#watchWanted` and no watcher is running:
  - try `#restartWatcherForLifecycle`;
  - on success, clear `#watchError`;
  - on failure, set `#watchError` to the error message.
  Emit a `config` settings event only when `watchError` changes. It **never throws**.
- **`#writeAndSync`:**
  - the watcher is stopped before the write, as today;
  - after the write, `#ensureWatcherForLifecycle` runs instead of the conditional restart;
  - **a watcher failure is no longer a sync failure**: the reload still runs after a success or conflict, and the write's result stands;
  - the `'the MCP config watcher could not restart'` sync step and its combined-error paths are deleted;
  - the reload step keeps its write-failure-first rule.
- **`readConfigText`** (the editor's load and Reload) calls `#ensureWatcherForLifecycle` first. The read never fails because of the watcher.
- **Config status:**
  - `toMcpConfigStatus` takes the watch error and emits `watchError` only when set (conditional spread);
  - the protocol's `McpConfigStatusSchema` gains `watchError: Schema.optional(Schema.String)`;
  - the v12 note gains: `Config status carries \`watchError\` while the config file watcher cannot run.`
- **UI.** When `watchError` is present, show a `role="alert"` notice with test id `mcp-config-watch-error` and exactly this text: `BrainStrike can't watch the MCP config file for outside edits: ${watchError}. Saving or reloading the config retries.` It renders in the MCP Config tab, or above the tabs, wherever the existing config status already flows without adding a second status read.

- [ ] **Step 1: Failing authority tests.**
  - The watcher restart fails during an editor save: the save returns success, the runtime still reloads (`replaceResolvedConfig` called), and the config status event carries `watchError`.
  - The same during a catalog install: the install succeeds, the token is kept, and `watchError` is set.
  - The next save or `readConfigText` retries: with `watch` succeeding again, `watchError` clears and a config event without it is emitted.
  - `watch` fails at `start()`: `watchError` is set and start does not throw.
  - After `close()`, nothing retries: `watch` is not called by a later operation that the lifecycle refuses.
  - Replace the existing watcher-restart-failure tests from the CAS work (editor and install B cases) with these new semantics. State in the report which tests were replaced and why.
- [ ] **Step 2: Implement the authority, sync, status and protocol changes.** Run the host-capabilities and agent-host suites until green, then build agent-host and host-capabilities.
- [ ] **Step 3: Failing UI tests.**
  - The notice renders with the exact text when `watchError` is present and is absent otherwise.
  - The desktop mapping carries `watchError` if it maps fields explicitly.
- [ ] **Step 4: Implement the UI and desktop changes.** Run settings-ui `src/settings/tools` and the desktop operations test.
- [ ] **Step 5: Type-check** agent-host, host-capabilities, settings-ui and desktop; run Biome.
- [ ] **Step 6: Commit** with `fix(mcp): the config watcher recovers on the next save or reload and says so while it cannot run`.

---

### Task 3: A post-write reload failure reads as a partial success

**Files:** `packages/host-capabilities/src/mcp/catalog-install.ts` and its tests in `mcp-settings-authority-catalog.test.ts`.

**Exact behavior:** when an install's write succeeded and the reload then failed (R3, now the only post-write failure, because the watcher no longer throws), the install rejects with:

```ts
new Error(`${entry.name} was added to the MCP config, but the MCP config could not be reloaded: ${errorMessage(cause)}`, { cause })
```

The token is kept. The editor path's reload-failure behavior is unchanged.

- [ ] **Step 1: Failing test.** Make `configFile.load` reject once, only on the post-write reload. Assert the exact message, that `.cause` is the original error, that `bearer.stored.size === 1`, and that the file contains the reference. Run it and see it fail.
- [ ] **Step 2: Implement.** Catalog and authority suites green, type-check, Biome.
- [ ] **Step 3: Commit** with `fix(mcp): an install that wrote the config but could not reload says it was added`.

---

## Validation (after all three tasks, before pushing to PR #3953)

| Command | Expect |
| --- | --- |
| `pnpm --filter @brainstrike/assistant-contract test` | pass |
| `pnpm --filter @brainstrike/host-capabilities test` | pass |
| `pnpm --filter @brainstrike/agent-host test` | pass |
| `pnpm --filter @brainstrike/settings-ui test` | pass |
| `pnpm --filter @brainstrike/desktop test` | pass |
| `pnpm type-check` | pass |
| `node --test scripts/__tests__/mcp-config-schema-ownership.test.mjs` | pass |
| `pnpm exec biome check packages/assistant-contract packages/host-capabilities packages/agent-host packages/settings-ui apps/desktop/src/renderer/components/settings` | 0 errors |
| `pnpm --filter @brainstrike/desktop exec vitest run --config vitest.integration.config.mts src/__tests__/agent-host-mcp-authority.integration.test.ts src/__tests__/main/mcp-surviving-host.integration.test.ts` | pass |
| `node scripts/run-turbo-command.mjs -- run build '--filter=@brainstrike/desktop...'`, then `pnpm --filter @brainstrike/desktop test:e2e e2e/mcp-host-settings.desktop.test.ts --project=regression` | pass, built mode, fresh desktop build |

Report each command's actual result. Classify any failure against the merge-base (`dfa894efc`) before attributing it.
