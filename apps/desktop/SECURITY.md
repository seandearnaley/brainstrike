# Desktop security

Security boundaries of the Electron app. Code is the reference; this file says where each boundary lives and what it guarantees.

## Content Security Policy and headers

- The policy is built by `packages/platform-utils/src/content-security-policy.ts` (target `electron`) and stamped on every response by `src/setup-security.ts`.
- Production:
  - `default-src 'self'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`.
  - `script-src 'self' blob: 'wasm-unsafe-eval'`: no CDN, no `unsafe-eval`, no inline script.
  - `connect-src` allows `'self'` and loopback (`127.0.0.1`/`localhost`, any port); the renderer reaches no model provider directly.
  - `frame-src` allows only the two sandbox shell schemes, `brainstrike-canvas:` and `brainstrike-mcp-app:`; never `blob:`.
  - `style-src` allows `'unsafe-inline'`; `img-src` allows `data:`, `blob:` and `brainstrike-asset:`.
- Development adds `localhost` sources, WebSockets and `'unsafe-inline'`/`'unsafe-eval'` scripts for Vite HMR.
- Response headers:
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
  - `X-XSS-Protection: 0` (the legacy auditor is itself a risk; CSP covers XSS).
  - `Permissions-Policy` disables camera, microphone, geolocation and payment.
  - The sandbox shell schemes are exempt from this stamp and carry their own headers (see MCP Apps below).

## Electron security settings

### WebPreferences (`src/create-window.ts`)

- `nodeIntegration: false`, `contextIsolation: true`, `webSecurity: true`.
- `sandbox: true` in packaged builds. Test runs turn it off (Playwright's Electron driver can't launch a sandboxed app in CI), and the `dev:electron`, `start` and `start:dev` scripts pass `--no-sandbox`.
- `allowRunningInsecureContent: false`, `experimentalFeatures: false`, `safeDialogs: true`, `navigateOnDragDrop: false`.

### Fuses

electron-builder flips Electron's fuses in every packaged build (`electronFuses` in package.json, BST-2357):

- `onlyLoadAppFromAsar` and `enableEmbeddedAsarIntegrityValidation`: the app loads only from `app.asar` and, on macOS and Windows, refuses an `app.asar` whose contents no longer match the embedded hash.
  - This resists tampering only in a code-signed app. Windows builds aren't signed yet (BST-2349), so there it catches corruption, not a rewritten app. Linux has no asar integrity check.
- `enableCookieEncryption`: the cookie store is encrypted with the OS key, as Chrome's is. One-way: turning it off corrupts existing profiles.
- `grantFileProtocolExtraPrivileges: false`: no page loads from `file://` (the renderer is served from `brainstrike-app://`), so `file://` pages get no more than a browser gives them.
- `runAsNode`, `enableNodeOptionsEnvironmentVariable` and `enableNodeCliInspectArguments` stay on (owner decision 2026-10-31; revisit once Windows builds are signed, BST-2349):
  - The agent host runs the TypeScript LSP, Node skill scripts, hooks and the Windows command wrapper through `ELECTRON_RUN_AS_NODE`; as a utility process it can't start utility processes itself.
  - `NODE_OPTIONS` carries `NODE_EXTRA_CA_CERTS`, which users behind a TLS-inspecting proxy need to reach hosted providers.
  - The packaged E2E lanes attach Playwright through `--inspect`.
- `resetAdHocDarwinSignature`: flipping a fuse rewrites the Electron binary, and Apple Silicon refuses a binary whose signature no longer matches. The signed macOS build is re-signed right after; the unsigned posture ([RELEASES.md](RELEASES.md)) is not, so the app is ad-hoc signed again after the flip.

### Navigation and IPC

- `setWindowOpenHandler` denies popups and `will-navigate` keeps the main frame inside the app.
- The renderer reaches main only through `contextBridge` preload APIs; filesystem operations go over IPC.
- One dispatcher rejects untracked senders and unrecognized frames before any handler runs; handlers validate their payloads.

## Crash reports

- Crash reports stay on the machine (BST-2351): Crashpad writes minidumps to `<userData>/Crashpad` with upload off.
- A minidump can hold process memory, so the thread debug pack lists only names, times and sizes, and factory reset deletes every report.

## Credential storage

- Provider keys, MCP bearer tokens and MCP OAuth records live in one private file in the profile, `brainstrike-credentials.sealed.json`. The agent host is its only writer; Main reads it.
- Every value is sealed with Electron `safeStorage`, which only Main can call; the host borrows it over its platform port (ADR-0029). Account names stay readable, so listing decrypts nothing.
- On macOS the key is one keychain item, `<app name> Safe Storage`, created and read by the signed app itself, so no keychain prompt appears. Windows protects the key with DPAPI, Linux with the Secret Service. Linux `basic_text` is refused.
- Unpackaged builds that seal credentials use the name `BrainStrike Desktop Dev`, so they never read the release's key. Isolated test runs keep a plain private file and never reach the OS keychain.

## Env bootstrap visibility (BST-1363)

The `secrets:envBootstrap` channel reports how desktop `.env` loading went, so a silently rejected file becomes repairable. It is a read-only projection.

- Names only, never values:
  - The payload carries variable names, env-file paths, an applied-variable count and the loader's own parse-failure messages. Never a value, or a prefix, hash or length of one.
  - This is structural, not a filter: the producer (`src/desktop-env-report.ts`) intersects the allow-listed name sets with presence in the process environment, reading a value only to ask whether it's non-blank. No code path copies a value into the result.
  - Pinned by `src/__tests__/desktop-env-report.test.ts`, which seeds a distinctive fake key and asserts the serialized payload doesn't contain it.
  - Paths are locations, not contents; they let the UI reveal a file the user must edit.
- The handler re-projects the recorded bootstrap result. It never re-runs env loading, so the channel can't make main read files on renderer demand.

## MCP HTTP OAuth (BST-1468)

`packages/host-capabilities/src/mcp/oauth-client-provider.ts` is an SDK v2 `OAuthClientProvider` for a single configured HTTP MCP resource.

- The official SDK owns RFC 9728 protected-resource discovery, RFC 8414/OIDC authorization-server discovery, CIMD/pre-registration/DCR selection, PKCE, RFC 8707 `resource`, issuer validation, refresh and 403 scope step-up. Brainstrike owns only main-process storage, the browser hand-off and the loopback callback.
- The callback binds `127.0.0.1` on an ephemeral port, accepts only the exact loopback `Host`, rejects invalid state without settling the flow, and passes the complete `URLSearchParams` to `finishAuth`.
  - Callback pages never echo authorization data; there is no HTTP cancellation route.
- Electron main exposes each armed callback exactly once to the production Streamable HTTP client through `takePendingAuthorizationCallback(signal)`.
  - The renderer receives no callback parameters.
  - Missing callbacks are not inferred as authorization retries. Cancellation, disconnect, replacement and provider close settle the pending wait and close the listener.
- Tokens, client registrations, verifiers, discovery state and resource identity are partitioned by configured server plus canonical resource, and stored as OAuth records in the sealed credential file.
  - `disconnect` and `invalidateCredentials('all')` clear disk and in-memory state; provider credentials are separate accounts and untouched.
- The provider fetch seam coalesces identical refresh-token requests and tags token responses with the current generation; a response from a generation disconnect invalidated is not persisted. Callers must pass the provider fetch to the SDK transport for this to apply.
- MCP config admits only token-free `none`, external bearer-reference and `oauth-user` modes for HTTP transports. Stdio can't select MCP HTTP OAuth, and an explicit auth mode can't be combined with an `Authorization` header.
- Startup reports an authentication-required state; only explicit Connect or Reauthorize passes the provider and its one-shot callback source to the host connection.
- Tests: `src/__tests__/main/mcp-oauth-client-provider.test.ts` (fake authorization server) and the adjacent credential-boundary and config unit tests.

### MCP external bearer references

- JSONC holds only the strict `mcp-credentials` UUID reference. The token is an `api_key` envelope in the profile credential store under `mcp-credentials:<uuid>`; there is no second store or plaintext channel.
- A token pasted into an MCP catalog install goes once over the `desktop-ui` host connection (`mcp/config/install`).
  - The host's bearer writer stores it under a fresh UUID; only the `{ store: 'mcp-credentials', id }` reference is written to the MCP config.
  - A failed config write removes the stored token again.
- `DesktopMcpHostRuntime` receives a credential authority capability, never a token.
  - It resolves on each request, validates the bearer-token grammar, rejects a competing Authorization header, binds use to the exact configured resource origin and attaches the header inside the final owned fetch boundary. It never caches the value.
- Public config/status and renderer IPC expose only the UUID reference or the token-free `malformed | missing | stored | unreadable` state.
  - The initial presence projection enumerates storage keys without decrypting; the final fetch boundary validates the token and publishes its state to the host snapshot.
  - Malformed, missing, unreadable, cross-origin and conflicting-auth failures have fixed codes and static messages; keychain errors and token material never reach runtime errors or diagnostics.
- Disconnect destroys the HTTP client but doesn't delete an externally managed credential another configuration may reference.
- Factory reset clears the shared secrets authority. Every fetch resolves afresh, so a client created before reset can't keep authenticating.

## MCP Apps sandbox and consent (BST-1572)

The boundary is an in-page nested iframe inside the main window, not a separate WebContents or session partition. Electron creates no WebContents for an in-page `<iframe>`, so no `web-contents-created` or session-level policy can observe an app frame.

- **Apps can be turned off (BST-1604).** On by default; a global Settings switch and a per-server `"extensions": { "apps": false }` entry in the MCP configuration each turn it off.
  - With Apps off for a server, the client never advertises `io.modelcontextprotocol/ui` on that connection, so no conformant server returns an app resource.
  - The change advances that server's connection generation, dropping its run-detached admissions; the renderer's enablement provider unmounts every app for it through the ordinary teardown (frame bridge close, tool-call authority close, generation retirement, shell release; the shell URL 404s immediately).
  - Nothing else here is conditional. The session policy is installed on `session.defaultSession` for the whole process, so a stale or racing frame can never regain a permission or a download.
- **App frame.** The untrusted document is an `about:srcdoc` iframe with `sandbox="allow-scripts"` (opaque origin; no `allow-same-origin`, `allow-popups`, `allow-downloads`, `allow-forms` or `allow-top-navigation`) and `allow` setting every reviewed permission to `'none'`.
  - It starts with a host-owned doctype and a per-document CSP meta tag built from the resource's validated `_meta.ui.csp` (`default-src 'none'`, no `unsafe-eval`, `form-action 'none'`, `worker-src 'none'`, connect/frame/resource domains only as declared).
- **Shell.** A host-authored shell document, whose only script is a literal bootstrap, creates the app frame.
  - The renderer renders the shell (`McpAppSandboxOwner`) and registers it through `window.mcp.apps.prepareShell`. Main serves it at `brainstrike-mcp-app://<128-bit token>/` from a privileged standard scheme (`apps-shell-protocol.ts`), so every shell has its own origin, never the host renderer's.
  - The shell receives the app policy as real `Content-Security-Policy` and `Permissions-Policy` response headers (the nested srcdoc inherits a header policy; `Permissions-Policy` is header-only). `setup-security.ts` exempts the scheme from the global stamp, like the Canvas shell.
  - The main window's CSP allows `frame-src brainstrike-canvas: brainstrike-mcp-app:` only. `blob:` is never a frame source: a blob shell would run on the host origin with no header CSP.
- **Fenced lifetime.** Each shell is bound to the registering WebContents id; only that sender may `releaseShell`.
  - Release makes the URL answer 404 immediately; WebContents destruction drops every shell it registered.
  - The renderer owner releases on unmount, on generation retirement and on a teardown that races an in-flight registration.
- **Frame bridge.** Host-app messages are fenced by origin (`null`), by the bound app-frame `source` (the cross-origin shell's first child window; the shell document itself is unreachable from the host) and by generation. Anything else is a protocol error that tears the mount down.
- **Navigation.** `setWindowOpenHandler` denies popups from every frame and `will-navigate` guards the main frame. `will-frame-navigate` (`apps-frame-navigation.ts`) denies the shell frame any navigation and the app frame anything but its own `about:srcdoc` load.
- **Session policy (BST-1599).** The app frame runs in the main window's session. The `allow` attribute and the shell's `Permissions-Policy` govern only Permissions-Policy features; `notifications` isn't one, and with no handler Electron grants every permission request (measured on Electron 43: `Notification.requestPermission()` from the app document resolved `granted`). `installMcpAppSessionPolicy` (`src/mcp/apps-session-policy.ts`, wired from `setup-security.ts` onto `session.defaultSession`) closes that:
  - `setPermissionRequestHandler` / `setPermissionCheckHandler` deny every permission whose `details.requestingUrl` is a sandbox shell (`brainstrike-mcp-app://` or `brainstrike-canvas://`), or is `about:srcdoc` while the requesting WebContents hosts an `about:srcdoc` frame whose parent is such a shell.
    - Electron reports no frame handle or usable origin for the opaque app document (`requestingOrigin` is empty; `embeddingOrigin` is the top frame's), so the srcdoc arm resolves from the frame tree and fails closed.
    - Both sandboxes are covered because Electron can't say which srcdoc frame asked, and neither has a legitimate use for a permission (the frame `allow` list already denies Permissions-Policy features, so the arm's real subjects are `notifications` and `openExternal`).
  - `requestingUrl` is required on the request handler but optional on the check handler (Electron omits it for cross-origin sub-frame checks, which is what an opaque sandbox document is), and APIs that check before requesting never reach the request handler.
    - So an unattributable sub-frame check is denied whenever the requesting WebContents hosts a sandbox frame. A main-frame check (`details.isMainFrame`) is never the sandbox and keeps Electron's default.
    - The host renderer's frames are never `about:srcdoc`, never carry a shell scheme, and its main frame always reports `isMainFrame`, so it is never denied; nothing is denied while no sandbox is mounted. The browser pane has its own partition and deny-by-default handlers.
  - Each denial is logged at `warn` once per (WebContents, arm, permission). Permission reads are synchronous, need no gesture and are silent to the page, so unthrottled logging would let untrusted content set the user's log write rate.
  - `will-download` cancels any download whose URL chain carries a shell origin (`brainstrike-mcp-app://…` or a `blob:brainstrike-mcp-app://…` a shell minted). Electron reports no frame for a download, so a blob URL is the only carrier of the initiating origin; the host renderer's own `blob:brainstrike-app://bundle/…` blobs are untouched.
    - The app document can't reach `will-download`: without `allow-downloads` Chromium blocks it first (asserted by the packaged lane).
    - The Canvas shell needs no download arm: unlike the MCP App shell (a real origin in an unsandboxed iframe), it is itself `sandbox="allow-scripts"`.
  - Pinned by `src/__tests__/main/mcp-apps-session-policy.test.ts` and the packaged lane's live probe, which exercises the request path (`Notification.requestPermission()`) and the check path (`Notification.permission`, `navigator.permissions.query`) from the app frame, the shell frame and the host renderer.
- **Tool calls.** App-originated calls use strict prepare/execute/release messages over the visible-UI-only `mcp:apps:*` IPC domain.
  - Every prepare names the persisted thread that owns the app's tool result. Main resolves only that thread's admission (never the latest run that knows the same server), requires it to admit the server, and binds the one-use executor to the requesting WebContents.
  - While the owning run is live, the executor is the run's gated tool entry. After the turn ends the admission is detached: the same static allow/ask decision and risk category gate the renderer consent dialog, and execution is a single `tools/call` on the process-level MCP host port for the exact configured server and tool name, pinned to the host generation live at detach. Detached calls carry no run hooks or telemetry.
  - Missing admission (no run ever, a retired server generation, a removed server, a closed host), malformed input, replay, release, supersession by a newer run and WebContents destruction all fail closed.
- An app's document is read through the agent host's desktop-only, generation-fenced `mcp/content/read` method (public-socket clients are refused) and used only with an exact `text/html;profile=mcp-app` MIME type and a text body.
- `window.mcp.apps.prepareShell` / `releaseShell` are the visible-UI-only `mcp:apps:prepareShell` / `mcp:apps:releaseShell` channels (strict schemas; per-sender and per-document size limits fail closed).
- The packaged proof (`e2e/mcp-apps-production-lifecycle.desktop.test.ts`, in `test:e2e:lane:packaged-mcp`) mounts an app in the real main window (production preload, default session, header CSP) and asserts: a `blob:` frame is blocked; the served shell loads and handshakes; the frame fence holds; the shell URL 404s after release; and a permission request from the app frame and a download from the shell frame are denied while the host renderer's are not.

## macOS code signing and notarization (BST-1627)

Release DMGs are signed with the owner's Developer ID Application identity and notarized through an App Store Connect API key. The app carries a stapled ticket, so Gatekeeper accepts a quarantined download offline. The DMG container is deliberately unsigned (electron-builder default; Gatekeeper assesses the app inside).

- **Hardened runtime and entitlements.** `build.mac.hardenedRuntime` is on and `signing/entitlements.mac.plist` is the complete entitlement set:
  - `allow-jit` and `allow-unsigned-executable-memory` for V8.
  - `disable-library-validation`, because the bundle loads code not signed by our Team ID (the Electron framework, `node-pty` prebuilds, the `@brainstrike/secure-fs-native` addon under `app.asar.unpacked`, the bundled CPython).
  - The app is not App-Sandboxed; no `app-sandbox` or `files.*` keys exist and none may be added "just in case".
- **Bundled CPython ships as loose, signed files.** Notarization scans inside archives and rejects python-build-standalone's ad-hoc-signed Mach-O files.
  - `scripts/fetch-python-runtime.mjs` unpacks the verified tarball at build time into `resources/python-runtime/unpacked/darwin-<arch>/`, and `extraResources` copies that tree (never a `.tar.gz`) into `<Resources>/python-runtime`, where osx-sign re-signs its Mach-O files.
  - The runtime resolver only verifies the tree's sentinel against the manifest sha256. Nothing is extracted or written under `userData`, and every launch sets `PYTHONDONTWRITEBYTECODE=1`.
- **Credentials never enter the repository or config.** Signing and notarization are env-driven (`CSC_LINK`/`CSC_KEY_PASSWORD` for the `.p12`; `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` for notarytool).
  - The root `.gitignore` refuses `*.p12`, `*.p8`, `*.cer`, `*.provisionprofile` and `AuthKey_*`.
  - In CI the `.p8` exists as a mode-0600 file under `RUNNER_TEMP` only for the packaging step. Locally, `APPLE_KEYCHAIN_PROFILE` (a `notarytool store-credentials` profile) is used so no key file exists on disk.
- **Evidence gate.** The release workflow fails each macOS leg (arm64 and x64, each on its own native runner) unless the app passes `codesign --verify --deep --strict`, reports a `Developer ID Application` authority, carries the entitlements above, has a stapled ticket (`xcrun stapler validate`), and is assessed by `spctl -a -t exec` as `source=Notarized Developer ID`.
  - Without `CSC_LINK`, or on an `unsigned` dispatch, the workflow passes no signing or notarization secret, builds the unsigned posture and asserts no Developer ID signature is present, so a build is never half-signed.

## Logging, DevTools and updates

- Packaged builds log at `info` unless `LOG_LEVEL` or Settings › Logging says otherwise.
- DevTools open from Developer › Toggle Developer Tools in unpackaged builds. Packaged builds have no DevTools menu item or shortcut.
- Renovate opens dependency and Electron updates (`.github/renovate.json5`).

## References

- [Electron security guidelines](https://www.electronjs.org/docs/tutorial/security)
- [Content Security Policy (MDN)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [OWASP Electron security](https://owasp.org/www-project-electron-security/)
