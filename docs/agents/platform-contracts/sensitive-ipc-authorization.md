# Two-factor sender authorization and the role table — evidence

Supports `docs/agents/platform-contracts.md` § "SENSITIVE DESKTOP IPC AUTHORIZATION".
Read before adding a sensitive invoke channel, changing the sender-frame allowlist, narrowing a preload manifest, or moving a channel between roles. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
## SENSITIVE DESKTOP IPC AUTHORIZATION

Electron preload possession is not an authorization boundary. Sensitive invoke
handlers use `registerAuthorizedInvoke` from
`apps/desktop/src/platform/desktop-ipc-registry.ts` and declare a non-empty set
of server-owned `DesktopWindowRole` values. Authorization runs BEFORE the
handler receives or parses any renderer-controlled argument and has two
factors (BST-1641):

1. **Sender role** — `event.sender.id` is resolved through `window-role.ts`
   and rejected unless it maps to a declared role. Empty and duplicate
   policies are registration errors; unknown senders never inherit
   `visible-ui`.
2. **Sender frame** — `event.senderFrame.url` must match the allowlist in
   `apps/desktop/src/platform/desktop-ipc-sender-frame.ts` (Electron's
   "Validate the sender of all IPC messages" checklist item). The allowlist is
   a pure derivation of the ONE process-wide `DesktopRendererTarget`
   (`apps/desktop/src/desktop-renderer-target.ts`): `main.ts` resolves the
   launch mode once (`resolveDesktopRendererLaunchMode`), builds the target,
   and configures it before any window exists; the visible window
   (`create-window.ts`) and the hidden hosts (`renderer-host-lifecycle.ts`)
   load the document that target names, and the allowlist is derived from the
   same object — so nothing re-derives the launch mode from
   `process.argv`/`app.isPackaged`/test-mode flags on its own, and the
   allowlist cannot trust a document the loaders never load (or reject the one
   they do). A loader that runs before the target is configured throws
   `Desktop renderer target is not configured.` at load time (visible window:
   `createWindow` rejects before any `loadFile`/`loadURL`; hidden host: the
   lifecycle reports `state: 'error'` with that `lastError`, un-retried),
   never as every authorized channel rejecting at first invoke. The target is
   launch-mode-exact: `built`/`test-built` accept ONLY the `file://` document
   at `resolveBuiltRendererPath()` (`dist-root.ts`), and `dev-server` accepts
   ONLY `DESKTOP_DEV_RENDERER_URL`'s origin + pathname — so a packaged app
   never trusts `http://localhost:38181` and a dev app never trusts a stray
   `file://` page. Query and fragment are ignored because hidden hosts load
   the same document as `?mode=<role>&runtimeId=…`; the dev pathname is
   compared for equality after trailing-slash normalization (`/desktop` ≡
   `/desktop/`, which Vite serves interchangeably), so a sibling file, a
   path-prefix spoof (`index.html.evil`, `/desktop-evil`) or another path
   does not match. **Standing rule:** the renderer is a single-document app —
   `RouterProvider` wraps a `BrowserRouter` shell with no routes, links, or
   `navigate` calls — and must stay that way: a history (`pushState`)
   navigation would change the frame's pathname mid-session and silently
   drop the visible window off the dev-server allowlist. A `null`/missing
   `senderFrame` (Electron nulls it after the frame navigated or was
   destroyed), a `WebFrameMain.url` getter that throws (Electron throws
   "Render frame was disposed…" for a disposed frame rather than returning
   null), an off-allowlist URL, and an unconfigured target ALL fail closed
   with a curated `Desktop IPC <channel> …` error; the renderer-controlled
   URL is never echoed into that message. Every rejection (role, missing or
   disposed frame, URL) is also logged in the main process by the
   `DesktopIpcRegistry` scope at `warn` WITH the channel and the rejected
   URL/sender id, where the renderer cannot read it, so allowlist drift and
   dev-server pathname mismatches are diagnosable.
   `createDesktopIpcRegistry({ senderFrameAllowlist })` injects an allowlist
   for unit tests; the desktop test setup configures a deterministic target
   process-wide (`TEST_DESKTOP_RENDERER_TARGET`), and suites that
   `vi.resetModules()` reinstall it on the fresh instance via
   `reconfigureTestRendererTargetAfterModuleReset` (a fresh module instance
   is unconfigured, i.e. fail-closed — by design, not a test bug).

The unauthenticated verb is deliberately the long one:
`registerUnauthenticatedInvoke(domain, channel, { reason }, handler)` requires
a non-empty reason (registration error otherwise) so every opt-out is
reviewable at the call site; the short `registerInvoke` no longer exists. The
reason states WHO holds the channel per the preload manifests
(`dist/preload.js` = `visible-ui`; `dist/hidden-preload.js` = the hidden
roles) and that a sender-role policy is pending. Channels not exposed by any
preload manifest cannot be invoked from a renderer at all, so "exposed only by
the visible-UI preload" is a factual caller set, not an authorization claim.

Sender-authorized domains and their roles (the preload manifests are the
source of truth for who may hold a channel; `hidden-preload.ts` exposes no
`fs:*`, `git:*`, `terminal:*`, `shell:*`, `changes:*`, `browser:*`, or
`command-sessions:*` channel):

| Domain / channels | Roles |
| --- | --- |
| `terminal:*` (create/write/resize/destroy), `command-sessions:*` | `visible-ui` |
| `shell:*` (open-external/open-path/show-item-in-folder) | `visible-ui` |
| `browser:*` (all 10 pane controls) | `visible-ui` |
| `fs:*` under `registerFileSystemIpcHandlers` (reads, root grants incl. `fs:addRootByPath`/`fs:requestDirectoryAccess`, `fs:readFileByPath`, `fs:readFileByAbsolutePath`, `fs:removeRoot`) | `visible-ui` |
| `db:query` | `chunking-host`, `embedding-host`, `visible-ui` |
| `db:exec`, `db:transaction` (raw SQL entry points; typed replacement is BST-1234), `db:diagnostics`, `db:scheduler:snapshot`, `db:test`, `db:managed-cache:apply-batch`, `db:managed-cache:invalidate-by-identity`, `db:chunks:insert-and-enqueue-embedding-jobs` — every `db:*` channel the embedding host's `hidden-preload.ts` bridge exposes besides the shared `db:query` | `embedding-host`, `visible-ui` |
| `db:ping`, `db:live-query:start`, `db:live-query:stop`, `db:live-query:refresh`, `db:clearAll`, `db:resetLocal`, `db:getUserDataPath` | `visible-ui` |
| `secrets:*`, `assistant:get-url`/`get-auth`, `provider-auth:*`, all 31 `mcp:*` invokes | `visible-ui` |
| `vector-preferences:read`, `vector-preferences:write`, `vector-preferences:clear` | `embedding-host` (pre-existing; see BST-1380 below) |
| `storage:*` production channels, `layout:*`, `settings:clearAll` | `visible-ui` |
| Contract-derived domains: `git:*` (all 15, incl. push/commit/switchBranch), `changes:*`, `forge:*`, `worktrees:*`, `command-sessions:*`, `terminal:*`, `notes-vault:*`, all `fs:*` file/root/watcher invokes, `clipboard:write-text`, `context-files:scan`, `skills:scan`, `user-commands:list`, `user-personas:list` | `visible-ui` |

Still `registerUnauthenticatedInvoke` with a stated reason (sender-role
policy pending, tracked as the BST-1641 follow-up):
`logging:get-preferences` (all four roles), `app:power-snapshot`
(visible UI + embedding host), `parser-host:parse` (visible UI + chunking
host), and the visible-UI-only hooks/file-exports/diagnostics/
assistant-checkpoint/embedding-backfill/runtime/agent-chat channels and the hidden-host lifecycle
controls (`*-host:ensure-started|stop|reset|get-status`, `chunking-host:chunk-*`,
`llm-host:*`, `embedding-host:query-embedding`). `tools:execute` is the
unregistered legacy harness (BST-1233).

Provider secrets plus assistant URL/token credentials are visible-UI-only.
Hidden chunking, embedding, and local-LLM windows use the role-selected
`dist/hidden-preload.js` capability manifest and do not receive those bridges.
This packaging boundary is defense in depth: main-process sender authorization
must remain even when a preload omits the channel. Add new sensitive invoke
channels through the authorized registration API and cover both an allowed
sender and hidden/untracked rejection. The browser pane host
(`browser/browser-pane-host.ts`) is sandboxed with NO preload and MCP App
iframes receive no preload either, so neither can reach `ipcRenderer` at all;
the sender-frame factor additionally rejects them by URL if that ever changes.

Paired tests: `apps/desktop/src/__tests__/platform/desktop-ipc-registry.test.ts`
(role rejection, spoofed/null/missing/disposed frame rejection with a valid
`sender.id`, unconfigured-target fail-closed, the main-process warn record,
mandatory reason), `desktop-ipc-sender-frame.test.ts` (allowlist matching
per launch mode, trailing-slash normalization, equality-not-prefix),
`desktop-renderer-target.test.ts` (for every launch mode and window role the
document the loaders load is on the allowlist derived from the same target,
and the other launch mode's document is not), the unconfigured-target
load-time failures in `create-window.test.ts` and
`renderer-host-lifecycle.test.ts`, `privileged-ipc-sender-authorization.test.ts`
(terminal, command sessions, shell, git, changes, forge, worktrees, notes vault, browser: allowed
visible-UI, hidden, untracked, and off-allowlist frame per channel, plus the
exact channel set), the same matrix for every contract-registered leaf domain
in `contract-domains-sender-authorization.test.ts`, the `files` sweep in
`ipc-domains/file-system-ipc.test.ts`, and the complete `db:*` role matrix in
`ipc-domains/db-ipc.test.ts`.

Narrowing a manifest can silently REMOVE a capability a hidden host still
depends on. BST-1235 dropped `electronAPI.storage` from the hidden hosts, and
the vector-preferences store quietly degraded to per-host browser storage —
so the embedding host stopped honouring the user's configured device
preference and fail-closed wherever WebGPU was unavailable (BST-1380). Two
standing rules follow:

1. When a hidden host genuinely needs shared persisted state, give it a
   PURPOSE-SCOPED capability, not the unrestricted `storage` bridge. The
   canonical shape is `vector-preferences:read|write|clear`: registered with
   `registerAuthorizedInvoke` for exactly the roles that need it, and carrying
   NO renderer-supplied key — main pins the record, so the capability can
   neither enumerate keys (`getAllKeys`) nor wipe the store (`clear`) nor be
   pointed at another key. Main duplicates the key literal rather than importing
   a renderer store module; a paired contract test pins the two together.
2. A store reached from more than one window role must FAIL VISIBLY when its
   capability is absent, never fall back to browser storage. "Electron renderer
   with no capability" and "web/SSR with no bridge at all" are different states
   and must not share a code path.

The handleless native file-read channel `fs:readFileByAbsolutePath` is also
visible-UI-only. Its typed payload carries both the requested absolute path and
the exact claimed mounted-root path plus its durable RootId. Main resolves the
RootId FIRST in the live `WorkspaceRootRegistry`, verifies the claimed
presentation/canonical path belongs to that same mount, and only then confines
the requested file. Duplicate presentation aliases or a symlink/junction
retarget therefore cannot make insertion order choose authority. Malformed
path/root/rootId assertions execute inside the durable denial logger and emit
exactly one bounded diagnostic record. Renderer-controlled requested paths and
handle RootIds are projected before entering that logger: control and
line-separator characters use visible Unicode escapes, each field is capped at
256 UTF-16 code units, and truncation ends with `…[truncated]`; non-string input
projects to the empty string. Error messages are never copied into the record:
the logger emits a static access/path-validation/filesystem category message
plus only a syntactically bounded safe error code, so native `realpath` text
cannot re-inject a path or line break through metadata. The legacy
`fs:readFileByPath` channel remains a separate generic mounted-path API and is
never a fallback for the scoped capability.
