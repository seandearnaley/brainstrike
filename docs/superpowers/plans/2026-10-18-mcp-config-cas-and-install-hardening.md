# MCP Config Compare-and-Swap and Install Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two follow-ups from PR #3953's final review:
- a catalog install never orphans or breaks a stored token, and one owner holds the catalog rules;
- the MCP config file is written compare-and-swap, so a stale editor Save or install can no longer silently overwrite newer content.

**Architecture:**
- **Task 1** keeps the existing install flow. It moves the catalog request rules into one exported contract function, and it decides token rollback by whether the config file was actually written.
- **Task 2** adds a content revision to the host-owned config file:
  - `McpConfigFile.readText` returns a SHA-256 revision of the text;
  - `writeText` refuses when the on-disk revision differs from the caller's base;
  - `mcp/config/read` exposes the revision, `mcp/config/write` requires `baseRevision`, and successes return the new revision. The host protocol becomes v12 (owner ruling 2026-10-18);
  - the settings editor tracks its base revision;
  - the catalog install uses the revision it read, so an external edit during the keychain write is refused and the token rolled back.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Effect Schema, Node `crypto`, React 19, Vitest + Testing Library, pnpm + turbo.

**Context:** builds on branch `claude/mcp-setup-linear-config-84b6aa` (PR #3953). Spec: `docs/superpowers/specs/2026-10-18-mcp-catalog-design.md`.

## Global Constraints

- Owner rulings 2026-10-18:
  - bump the host protocol to v12 for the required `baseRevision`; no optional-field bypass;
  - both follow-ups land on PR #3953's branch.
- One authoritative writer: `McpSettingsAuthority` and `McpConfigFile` own the config file. The bearer module owns `mcp-credentials:<uuid>`.
- No silent fallback or degradation. Every refusal is a visible failure result with the exact message below. A stale base is never written "anyway".
- TypeScript strict, no `any`, `exactOptionalPropertyTypes` (conditional spreads). Biome: sorted keys and props, block statements, at most 1000 code lines per file, at most 20 cognitive complexity per function.
- The MCP grammar comes only from `@brainstrike/assistant-contract/mcp-config` and the catalog only from `@brainstrike/assistant-contract/mcp-catalog`. Neither is re-exported from the package root, and the catalog declares no Schema shapes.
- Never log or print a token. Tests use fixture tokens.
- Red first. Characterization tests are proven by a temporary mutation that is then restored.
- One commit per task, conventional message, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Hooks run; never `--no-verify`. When a hook fails, confirm the errors reproduce on a direct run before calling them unrelated.
- Downstream packages type-check against built `dist`. Build changed packages before type-checking their consumers: `node scripts/run-turbo-command.mjs -- run build '--filter=<pkg>'`.

---

### Task 1: Install rollback by write outcome, and one owner for the catalog rules

**Files:**
- Modify: `packages/assistant-contract/src/mcp-catalog.ts`
- Modify: `packages/assistant-contract/src/__tests__/mcp-catalog.test.ts`
- Modify: `packages/host-capabilities/src/mcp/settings-authority.ts` (`catalogRequestRefusal`, `installCatalogServer`, `#commitConfigText`)
- Modify: `packages/host-capabilities/__tests__/mcp-settings-authority-catalog.test.ts`

**Interfaces:**
- Produces, from `@brainstrike/assistant-contract/mcp-catalog`:
  - `mcpCatalogInstallRefusal(entry: McpCatalogEntry, request: { readonly access: McpCatalogAccess; readonly hasToken: boolean }): string | undefined`. It returns exactly one of these, checked in this order, or `undefined`:
    1. `${entry.name} has no ${access} endpoint.`
    2. `${entry.name} signs in with OAuth and takes no token.` (an OAuth entry with `hasToken`)
    3. `${entry.name} needs a token.` (a token entry without `hasToken`)
  - `type McpCatalogCredentialReference = (typeof McpCredentialReferenceSchema)['Encoded']`, through `import type { McpCredentialReferenceSchema } from './mcp-host.js'`. This replaces the hand-written interface. No runtime import.
- `mcpCatalogServerInput(entry, access, credential?)` calls `mcpCatalogInstallRefusal(entry, { access, hasToken: credential !== undefined })` and throws `new Error(refusal)` when it returns a message. Builder messages therefore become identical to the authority's: the old `'GitHub needs a stored token'` becomes `'GitHub needs a token.'`, and the others gain the trailing period.
- The authority's `catalogRequestRefusal` is deleted. `installCatalogServer` calls `mcpCatalogInstallRefusal(entry, { access: request.access, hasToken: request.token !== undefined })` after the unknown-id check. Every authority refusal string stays byte-identical to today.

**Rollback requirements for `installCatalogServer`.** A token was stored (`credential !== undefined`) and the commit did not end in a success result:

| Commit outcome | File written? | Token | Install result |
| --- | --- | --- | --- |
| R1: returned `{ success: false }` | no | delete | the failure, as today (including the existing double-failure message) |
| R2: rejected before `configFile.writeText` resolved success, e.g. path resolution or a write that threw | no | delete | reject with `Error` whose message is `${original message}; the stored ${entry.name} token was removed` (or `…; the stored ${entry.name} token could not be removed: ${cause}` when the delete also fails). The original is kept as `cause`. |
| R3: rejected after `writeText` resolved success, e.g. watcher restart or reload threw | yes | **keep**: the file references it | reject with the original error, unchanged |

Implement this by having `#commitConfigText` report whether the write persisted, for example an `onWritten` callback or a small structured return. Do not try to infer it from the error type. `writeConfigText`'s behavior must not change.

- [ ] **Step 1: Write failing contract tests.**
  - `mcpCatalogInstallRefusal` returns each of the three messages and `undefined` for a valid request, covering all four entries.
  - The existing `refuses a build that does not match the entry` test now expects the period-terminated messages, including `'GitHub needs a token.'`.
  - Run `pnpm --filter @brainstrike/assistant-contract exec vitest run src/__tests__/mcp-catalog.test.ts` and see it fail.
- [ ] **Step 2: Implement the contract change.** Run the test until it passes, then `pnpm --filter @brainstrike/assistant-contract type-check && pnpm --filter @brainstrike/assistant-contract build` and `node --test scripts/__tests__/mcp-config-schema-ownership.test.mjs`.
- [ ] **Step 3: Write failing authority tests**, in the catalog test file. GitHub with a token in each case:
  - **R2:** `vi.spyOn(h.configFile, 'writeText').mockRejectedValueOnce(new Error('EACCES: permission denied'))`. The install rejects with `'EACCES: permission denied; the stored GitHub token was removed'`, and `h.bearer.stored.size === 0`.
  - **R2 with a failed delete:** the same, plus `h.bearer.writer.delete.mockRejectedValueOnce(new Error('keychain locked'))`. The install rejects with `'EACCES: permission denied; the stored GitHub token could not be removed: keychain locked'`.
  - **R3:** `writeText` resolves success, then the watcher restart rejects. The harness's `configFile.watch` is a `vi.fn`; after `start()`, use `h.configFile.watch.mockRejectedValueOnce(new Error('watch failed'))`, since `#restartWatcherForLifecycle` and `#reloadForLifecycle` both propagate. The install rejects with `'watch failed'`, `h.bearer.stored.size === 1`, and the file contains the bearer reference id.
  - Run and see each fail on today's code.
- [ ] **Step 4: Implement the shared check and the rollback.** All catalog tests pass, and the three existing authority suites still pass (`mcp-settings-authority.test.ts`, `-status`, `-preferences`). Then `pnpm --filter @brainstrike/host-capabilities type-check` and `pnpm exec biome check packages/host-capabilities/src/mcp/settings-authority.ts packages/assistant-contract/src/mcp-catalog.ts`.
- [ ] **Step 5: Commit** with: `fix(mcp): catalog install rolls back its token by write outcome, and one contract check owns the catalog rules`.

---

### Task 2: Compare-and-swap MCP config writes (host protocol v12)

**Files:**
- `packages/host-capabilities/src/mcp/config-file.ts`: revision helper; `readText` returns `revision`; `writeText(content, baseRevision)` checks it.
- `packages/host-capabilities/src/mcp/settings-authority.ts`: `writeConfigText` passes `baseRevision`; install passes the revision it read and maps a conflict.
- `packages/host-capabilities/__tests__/mcp-config-file*.test.ts` and `mcp-settings-authority*.test.ts` (update call sites, add tests). Also `mcp-settings-authority-harness.ts` if helpers need the revision.
- `packages/agent-host/src/protocol-mcp-settings.ts`: read result `revision`; write params `baseRevision`; result schema.
- `packages/agent-host/src/protocol.ts`: `AGENT_HOST_PROTOCOL_VERSION = 12` and a v12 note.
- `packages/agent-host/__tests__/fixtures/host-v11-methods.json` → renamed `host-v12-methods.json` with `"version": 12`. Update `host-wire-ownership.test.ts` (import and `toBe(12)`) and `client-wire-decoding.test.ts` (`protocolVersion`). Grep `packages` and `apps` for every other hard-coded protocol version 11 in host records or fixtures and update it.
- `packages/settings-ui/src/settings/tools/types.ts`: `McpConfigTextDocument.revision`; `writeMcpConfigText(content, baseRevision)`; the result union.
- `packages/settings-ui/src/settings/tools/mcp-config-panel.tsx`: tracks `baseRevision`; Save sends it; install prompt copy.
- `packages/settings-ui/src/settings/tools/__tests__/mcp-config-panel.test.tsx` (plus any settings-ui test that builds a text document or write result).
- `apps/desktop/src/renderer/components/settings/page-content.tsx`: route passes `baseRevision`.
- `apps/desktop/src/__tests__/renderer/components/settings/page-content-operations.test.tsx`
- `apps/desktop/src/__tests__/main/mcp-host-service.test.ts` and any other test that calls the authority's `writeConfigText` (the compiler is the census).
- `docs/superpowers/specs/2026-10-18-mcp-catalog-design.md`: add §4.4 "Compare-and-swap writes" (what is below, in 5-8 lines) and remove "Compare-and-swap" from §7.

**Interfaces and exact behavior:**
- `config-file.ts` exports `mcpConfigRevision(text: string): string`, the lowercase hex SHA-256 of the UTF-8 text from `node:crypto` `createHash`. An absent file has the revision of `''`.
- `McpConfigTextDocument` (host) gains `revision: string`, always present. It is the revision of the `content` returned, or of `''` when `exists: false`.
- `McpConfigFile.writeText(content: string, baseRevision: string): Promise<McpConfigWriteResult>`:
  1. validate with `parseMcpConfig`, as today;
  2. read the current on-disk text (`''` if absent) and compute its revision. If it differs from `baseRevision`, return `{ conflict: true, error: 'The MCP config changed on disk since it was read. Reload it, then save again.', path, success: false }` and write nothing;
  3. otherwise write and return `{ path, revision: mcpConfigRevision(content), success: true }`.
  A comment states the remaining window: the check and the write are adjacent and serialized inside this process, but an external writer in between can still race. That is acceptable for an editor file.
- `McpConfigWriteResult` (host) becomes `{ path: string; revision: string; success: true } | { conflict?: true; error: string; path: string; success: false }`.
- Protocol, `protocol-mcp-settings.ts`:
  - `McpConfigTextSchema` gains `revision: Schema.String`;
  - `'mcp/config/write'` params become `Schema.Struct({ baseRevision: Schema.String, content: Schema.String })`;
  - `McpConfigWriteResultSchema` success gains `revision: Schema.String` and failure gains `conflict: Schema.optional(Schema.Literal(true))`. This is shared by write and install.
- `protocol.ts`: add the v12 note below directly above the constant, and set the constant to 12:
  > v12 (2026-10-18): `mcp/config/read` returns the config text's `revision` (a SHA-256 of its content). `mcp/config/write` requires `baseRevision` and refuses a stale base with `conflict: true` instead of overwriting. Write and catalog-install successes return the new `revision`. The required parameter is why this is a version bump and not a v11 addition.
- Authority:
  - `writeConfigText({ baseRevision, content })` keeps its empty and size checks, then commits with `baseRevision`.
  - `installCatalogServer` passes `document.revision` from its own `readText(true)` to the commit.
  - On an install conflict the result is `{ conflict: true, error: \`The MCP config changed while installing ${entry.name}; nothing was installed. Try again.\`, path, success: false }`, and the stored token is deleted. This reuses Task 1's R1 rollback, including its double-failure message.
- settings-ui types:
  - `McpConfigTextDocument.revision: string`.
  - `writeMcpConfigText?: (content: string, baseRevision: string) => Promise<{ success: true; path: string; revision: string } | { success: false; path: string; error: string; conflict?: true }>`.
  - `installMcpCatalogServer`'s result union matches (success has `revision`; failure may have `conflict`).
- Panel:
  - the reducer holds `baseRevision: string | null`;
  - `DOCUMENT_LOADED` sets it from the document, and `SAVE_SUCCESS` sets it from the write result's `revision`;
  - `handleSave` sends `writeMcpConfigText(editorValue, baseRevision)`. Save is already unavailable before the document loads; keep it that way;
  - a conflict failure shows the host's message through the existing save-failure path and keeps the editor text.
  The install-reason reload prompt copy becomes, exactly: `${name} was added to the config on disk. Reload to see it; your unsaved edits can't be saved until you reload.` The Reload button's generic copy is unchanged.
- Desktop route: `writeMcpConfigText: async (content: string, baseRevision: string) => await mcpSettings.request('mcp/config/write', { baseRevision, content })`.

- [ ] **Step 1: Write failing config-file tests.**
  - `readText` returns the SHA-256 revision of its content, and of `''` when absent.
  - `writeText` with the current revision writes and returns the new revision.
  - `writeText` with a stale revision (the file was changed after the read) returns the exact conflict result and leaves the file byte-identical.
  - `writeText` creates a missing file when the base is the empty revision.
  - Update the existing `writeText(content)` call sites to pass the revision.
  - Run and see the new tests fail.
- [ ] **Step 2: Implement `config-file.ts`.** Run the config-file suites until green.
- [ ] **Step 3: Write failing authority tests.**
  - An editor write with a stale `baseRevision` returns the conflict and does not reload or replace the runtime config.
  - An install where the file changes between the read and the commit returns the install-conflict message, deletes the token, and leaves the external edit intact. Simulate the change inside `h.bearer.writer.create` before it resolves, which models a keychain prompt.
  - A successful write and a successful install both return `revision` equal to `mcpConfigRevision` of the new file text.
  - Run and see them fail.
- [ ] **Step 4: Implement the authority changes and the protocol v12 changes** (schemas, constant, note, fixture rename, version tests). Run host-capabilities and agent-host tests until green. Build `assistant-contract`, `agent-host` and `host-capabilities`.
- [ ] **Step 5: Write failing UI tests.**
  - The panel sends the loaded document's revision on Save.
  - After a successful save, the next Save sends the returned revision.
  - A conflict result shows the host message and keeps the editor text.
  - The install-reason prompt uses the new copy.
  - The desktop operations test asserts `('mcp/config/write', { baseRevision, content })`.
  - Run and see them fail.
- [ ] **Step 6: Implement the settings-ui and desktop changes.** Run settings-ui `src/settings/tools` and the desktop operations test until green.
- [ ] **Step 7: Update the spec** (§4.4 added, §7 entry removed). Then run `pnpm --filter @brainstrike/agent-host type-check`, `pnpm --filter @brainstrike/host-capabilities type-check`, `pnpm --filter @brainstrike/settings-ui type-check`, `pnpm --filter @brainstrike/desktop type-check` and Biome on the touched files.
- [ ] **Step 8: Commit** with: `feat(mcp): compare-and-swap MCP config writes; host protocol v12 carries the config revision`.

---

## Validation (after both tasks, before pushing to PR #3953)

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
| `pnpm --filter @brainstrike/desktop test:e2e e2e/mcp-host-settings.desktop.test.ts --project=regression` | pass, built mode |

Report each command's actual result. Classify any failure against the merge-base (`dfa894efc`) before attributing it.
