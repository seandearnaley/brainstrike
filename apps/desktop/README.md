# Brainstrike desktop

Electron hosts the React UI, native platform adapters and the shared agent-host
attachment. Desktop and web share UI packages but have different runtime owners.

## Development

Use the repository-pinned Node and pnpm versions. From the repository root:

```sh
pnpm install
pnpm build
pnpm dev --filter @brainstrike/desktop
```

From `apps/desktop`, `pnpm dev` starts the Vite renderer and builds/launches
Electron. The default renderer URL is `http://localhost:38181`; both Vite and
Electron use the configuration in
[`desktop-renderer-config.ts`](src/desktop-renderer-config.ts). Renderer edits use
Vite hot reload; restart Electron after changing main or preload code.

| Command in `apps/desktop` | Purpose |
| --- | --- |
| `pnpm dev:renderer` | Start the renderer dev server |
| `pnpm dev:main` | Build main/preload and helper entries |
| `pnpm dev:electron` | Build and launch against the running dev server |
| `pnpm build` | Build renderer and main |
| `pnpm start` | Build and launch the built renderer |
| `pnpm type-check` | Check desktop TypeScript |

[`package.json`](package.json) owns the complete command list. Packaging, signing
and distribution are separate from ordinary development and need owner authorization.

### macOS Keychain prompts

Ordinary dev launches from every worktree share one Keychain credential service.
Electron's dev binary is ad-hoc signed, so macOS ties each "Always Allow" to that
exact build: an Electron upgrade, or a worktree on another Electron version, asks
again for every stored credential. To make grants last, opt in to signing the
installed `Electron.app` with your own code-signing identity:

```sh
export BRAINSTRIKE_DEV_ELECTRON_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
pnpm install
```

Export it from a file every shell reads (for zsh, `~/.zshenv`) so worktree installs
see it. The desktop `postinstall` then signs Electron for local use (no hardened
runtime, no timestamp), skips a bundle already signed by that identity, and fails
the install if the identity cannot sign. pnpm skips lifecycle scripts when an
install is already up to date, so in an existing checkout run
`node apps/desktop/scripts/sign-dev-electron.mjs` once instead. Restart a running
dev app after signing, then choose "Always Allow" once per prompt; those grants
survive later Electron upgrades.

## Runtime boundaries

- Electron main owns windows, authorized IPC and platform lifecycle. The visible
  renderer uses role-scoped preload capabilities rather than direct Node access.
- The Electron-free agent host owns runs, committed conversations and workspace
  authority. Its SQLite StateStore owns the canonical catalog; desktop and CLI
  clients attach through the authenticated host protocol.
- The derived SQLite index has its own process and lifecycle. Desktop has no
  PGlite engine or renderer SQL/live-query bridge. PGlite still exists in web and
  explicit test consumers.
- Embeddings and local model generation run in hidden renderer hosts. Their
  lifetime is managed separately from the visible UI.
- Preference storage is distinct from the canonical host catalog and derived
  indexes. Clear Database retains configuration/credentials; Factory Reset also
  clears them. See the [reset contract](../../docs/agents/platform-contracts.md)
  for lifecycle and platform limits.

The preload and IPC implementation is the API reference; historical examples of
`window.electronAPI.db` do not describe the current desktop surface. BrowserWindow
security settings live in [`create-window.ts`](src/create-window.ts). Development
launches include `--no-sandbox`, so they do not demonstrate Chromium sandboxing.

## Testing and debugging

**CI is disabled due to cost; validation must run locally.** Use
[validation guidance](../../docs/agents/ci-quality.md) and the
[desktop E2E guide](e2e/README.md) to select appropriate checks.

`pnpm dev:agent-debug` is an opt-in disposable debugging session. Never use Sean's
protected profile for automated debugging or reset. Debugging does not belong in
the default E2E launch. Native binaries and packaged paths must be checked on the
actual affected platform/artifact when those boundaries change.
