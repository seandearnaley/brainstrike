# Brainstrike desktop

Electron hosts the React UI, native platform adapters and the attachment to the shared agent host.

## Development

From the repository root: `pnpm install`, then `pnpm dev`.

- `pnpm dev` (in `apps/desktop`) starts the Vite renderer and builds and launches Electron.
- The renderer URL defaults to `http://localhost:38181`; Vite and Electron both read [`desktop-renderer-config.ts`](src/desktop-renderer-config.ts).
- Renderer edits hot-reload; restart Electron after changing main or preload code.

| Command in `apps/desktop` | Purpose |
| --- | --- |
| `pnpm dev:renderer` | Start the renderer dev server |
| `pnpm dev:main` | Build main/preload and helper entries |
| `pnpm dev:electron` | Build main and launch against the running dev server |
| `pnpm build` | Build renderer and main in parallel |
| `pnpm start` | Build and launch the built renderer |
| `pnpm type-check` | Check desktop TypeScript |

- [`package.json`](package.json) has the full command list.
- Packaging, signing and distribution need owner authorization; see [RELEASES.md](RELEASES.md).

### macOS Keychain prompts

Dev launches share one Keychain credential service, and the ad-hoc signed Electron dev binary makes each "Always Allow" grant expire on every Electron version change. To make grants last:

- Export your code-signing identity from a file every shell reads (for zsh, `~/.zshenv`):

  ```sh
  export BRAINSTRIKE_DEV_ELECTRON_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
  ```

- Run `pnpm install`; the desktop `postinstall` signs `Electron.app` for local use (no hardened runtime, no timestamp) and fails if the identity cannot sign.
  - An up-to-date install skips lifecycle scripts; in an existing checkout run `node apps/desktop/scripts/sign-dev-electron.mjs` once instead.
- Restart the dev app and choose "Always Allow" once per prompt.

## Runtime boundaries

- Electron main owns windows, authorized IPC and platform lifecycle. The renderer uses role-scoped preload capabilities, never direct Node access.
- The Electron-free agent host owns runs, committed conversations and workspace authority.
  - Its SQLite StateStore owns the canonical catalog.
  - Desktop and CLI clients attach through the authenticated host protocol.
- The derived SQLite index has its own process and lifecycle. The renderer has no SQL bridge.
- Renderer preferences live in `localStorage` and Main's settings in its settings store (`brainstrike-settings`), both separate from the canonical catalog and derived indexes.
  - Clear content (Settings) keeps configuration and credentials; Factory Reset also clears them.
  - See the [reset contract](../../docs/agents/platform-contracts.md).
- The preload and IPC code is the API reference. BrowserWindow security settings live in [`create-window.ts`](src/create-window.ts); see also [SECURITY.md](SECURITY.md).
- Dev launches pass `--no-sandbox`, so they don't exercise Chromium sandboxing.

## Testing and debugging

- Before a PR run only the narrow checks for what changed (root [`AGENTS.md`](../../AGENTS.md)); the merge queue runs every lane.
- Unit and integration tests: [`src/__tests__/README.md`](src/__tests__/README.md). E2E: [`e2e/README.md`](e2e/README.md).
- `pnpm dev:agent-debug` starts an opt-in, disposable debugging session. Never use Sean's protected profile for automated debugging or reset.
- When native binaries or packaged paths change, check them on the affected platform and artifact.
