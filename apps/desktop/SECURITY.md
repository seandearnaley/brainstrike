# Desktop security

Security boundaries of the Electron app. Code is the reference; this file says where each boundary lives and what it guarantees.

## Content Security Policy and headers

- The policy is built by `packages/platform-utils/src/content-security-policy.ts` (target `electron`) and stamped on every response by `src/setup-security.ts`.
- Production:
  - `default-src 'self'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`.
  - `script-src 'self' blob: 'wasm-unsafe-eval'`: no CDN, no `unsafe-eval`, no inline script.
  - `connect-src` allows `'self'`, loopback (`127.0.0.1`/`localhost`, any port) and the embedding provider origins the renderer calls directly (OpenAI, Google, Cohere, Voyage).
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
- `sandbox: true` in packaged builds. Test runs turn it off (Playwright's Electron driver cannot launch a sandboxed app in CI), and the `dev:electron`, `start` and `start:dev` scripts pass `--no-sandbox`.
- `allowRunningInsecureContent: false`, `experimentalFeatures: false`, `safeDialogs: true`, `navigateOnDragDrop: false`.

### Fuses
electron-builder flips Electron's fuses in every packaged build (`electronFuses`
in package.json, BST-2357):
- `onlyLoadAppFromAsar` and `enableEmbeddedAsarIntegrityValidation`: Electron
  loads the app only from `app.asar` and, on macOS and Windows, refuses an
  `app.asar` whose contents no longer match the hash electron-builder embeds
  in the app. The check resists tampering only in a code-signed app: Windows
  builds are not signed yet (BST-2349), so there it catches corruption, not a
  rewritten app. Linux has no asar integrity check
- `enableCookieEncryption`: the cookie store is encrypted with the OS key, as
  Chrome's is. This is one-way: turning it off again corrupts existing profiles
- `grantFileProtocolExtraPrivileges: false`: no page loads from `file://` (the
  renderer is served from `brainstrike-app://`), so `file://` pages get no more
  than a browser gives them
- `runAsNode`, `enableNodeOptionsEnvironmentVariable` and
  `enableNodeCliInspectArguments` stay on. The agent host runs the TypeScript
  LSP, Node skill scripts, hooks and the Windows command wrapper through
  `ELECTRON_RUN_AS_NODE`, and as a utility process it cannot start utility
  processes itself. `NODE_OPTIONS` also carries `NODE_EXTRA_CA_CERTS`, which
  users behind a TLS-inspecting proxy need to reach hosted providers, and the
  packaged E2E lanes attach Playwright through `--inspect`. The owner kept them
  on (2026-10-31), to revisit once Windows builds are signed (BST-2349)
- `resetAdHocDarwinSignature`: flipping a fuse rewrites the Electron binary, and
  Apple Silicon refuses to run a binary whose signature no longer matches. The
  signed macOS build is signed again right after, but the unsigned posture
  (RELEASES.md) is not, so the app is ad-hoc signed again after the flip

### Navigation and IPC

- `setWindowOpenHandler` denies popups and `will-navigate` keeps the main frame inside the app.
- The renderer reaches main only through `contextBridge` preload APIs; filesystem and storage operations go over IPC.
- One dispatcher rejects untracked senders and unrecognized frames before any handler runs; handlers validate their payloads.

## Storage

- Crash reports stay on the machine (BST-2351): Crashpad writes minidumps to `<userData>/Crashpad` with upload off. A minidump can hold process memory, so the thread debug pack lists only names, times and sizes, and factory reset deletes every report.

## Credential storage
- Provider keys, MCP bearer tokens and MCP OAuth records live in one private
  file in the profile, `brainstrike-credentials.sealed.json`. The agent host is
  its only writer; Main reads it.
- Every value is sealed with Electron `safeStorage`, which only Main can call;
  the host borrows it over its platform port (ADR-0029). Account names stay
  readable, so listing decrypts nothing.
- On macOS the key is one keychain item, `<app name> Safe Storage`, created and
  read by the signed app itself, so no keychain prompt appears. Windows protects
  the key with DPAPI and Linux with the Secret Service. Linux `basic_text`
  is refused, never used.
- Unpackaged builds that seal credentials take the name
  `BrainStrike Desktop Dev`, so they never read the release's key. Isolated test
  runs keep a plain private file and never reach the OS keychain.

## Env Bootstrap Visibility (BST-1363)

The `secrets:envBootstrap` channel reports how desktop `.env` loading went so a
silently-rejected file becomes repairable. It is a READ-ONLY projection with a
hard payload rule.

### Names only, never values
- The payload carries variable NAMES, env-file PATHS, an applied-variable
  count, and the loader's own parse-failure messages. It never carries a
  variable's VALUE — nor a prefix, hash, or length of one.
- This is structural, not a filter: the producer
  (`src/desktop-env-report.ts`) intersects the allow-listed NAME sets with
  mere PRESENCE in the process environment, reading a value only to ask "is
  this non-blank?". No code path copies a value into the result, so there is
  nothing to accidentally forget to redact.
- Pinned by `src/__tests__/desktop-env-report.test.ts`, which seeds a
  distinctive fake key value and asserts the serialized payload does not
  contain it.
- Paths are file locations, not file contents; they exist so the UI can reveal
  a file the user must go edit.

### Sender policy
- Every desktop IPC call goes through one dispatcher that rejects untracked
  senders and unrecognized frames before the handler runs.
- The handler re-projects the RECORDED bootstrap result; it never re-runs env
  file loading, so this channel cannot be used to make the main process read
  files on renderer demand.

## MCP HTTP OAuth (BST-1468)

The implementation lives in
`packages/host-capabilities/src/mcp/oauth-client-provider.ts` and is an SDK v2 `OAuthClientProvider` for a
single configured HTTP MCP resource.

- The official SDK owns RFC 9728 protected-resource discovery, RFC 8414/OIDC
  authorization-server discovery, CIMD/pre-registration/DCR selection, PKCE,
  RFC 8707 `resource`, issuer validation, refresh, and 403 scope step-up.
  Brainstrike owns only the main-process storage, browser hand-off, and
  loopback callback seam.
- The callback binds to `127.0.0.1` on an ephemeral port, accepts only the
  exact loopback `Host`, rejects invalid state without settling the flow, and
  passes the complete `URLSearchParams` to `finishAuth`. Callback pages never
  echo authorization data and there is no HTTP cancellation route.
- Electron main exposes each armed callback exactly once to the production
  Streamable HTTP client through `takePendingAuthorizationCallback(signal)`.
  The renderer receives no callback parameters. Missing callbacks are not
  inferred as authorization retries; cancellation, disconnect, replacement,
  and provider close settle the pending wait and close the loopback listener.
- Tokens, client registrations, verifiers, discovery state, and resource
  identity are partitioned by configured server plus canonical resource and
  are OAuth records in the profile's sealed credential file (see Credential
  storage). `disconnect` and `invalidateCredentials('all')` clear disk and
  in-memory state; provider credentials are separate accounts and are
  untouched.
- The provider fetch seam coalesces identical refresh-token requests and
  tags token responses with the current generation. A response from a
  generation invalidated by disconnect is not persisted. Callers must pass
  the provider fetch to the SDK transport so this authority is active.
- MCP config admits only token-free `none`, external bearer-reference, and
  `oauth-user` modes for HTTP transports. Stdio cannot select MCP HTTP OAuth,
  and an explicit auth mode cannot be combined with an `Authorization` header.

### MCP external bearer references

- JSONC contains only the strict `mcp-credentials` UUID reference. Its token is
  an `api_key` envelope in the profile credential store under
  `mcp-credentials:<uuid>`; no second credential store or plaintext
  configuration channel exists.
- Settings sends a token pasted into an MCP catalog install once, over the
  `desktop-ui` host connection (`mcp/config/install`). The host's bearer writer
  stores it under a fresh UUID in the profile credential store, and only the
  `{ store: 'mcp-credentials', id }` reference is written to the MCP config. A
  failed config write removes the stored token again.
- `DesktopMcpHostRuntime` receives a credential authority capability, never a
  token. The capability resolves on each request, validates the bearer-token
  grammar, rejects a competing Authorization header, binds use to the exact
  configured resource origin, and attaches the header inside the final owned
  fetch boundary. It does not cache the resolved value.
- Public config/status and renderer IPC expose only the UUID reference or the
  token-free `malformed | missing | stored | unreadable` state. The initial
  presence projection enumerates storage keys without decrypting tokens; the
  final owned fetch boundary validates the token and publishes its current
  state back to the host snapshot. Malformed, missing, unreadable,
  cross-origin, and conflicting-auth failures have fixed codes and static
  messages; underlying keychain errors and token material are not chained into
  runtime errors or diagnostics.
- Disconnect destroys the HTTP client/closure but does not delete an externally
  managed credential that another configuration may reference. Factory reset
  clears the shared secrets authority; because every fetch resolves afresh, a
  closure created before reset cannot continue authenticating afterward.

The fake-authorization-server suite is
`src/__tests__/main/mcp-oauth-client-provider.test.ts`; the
credential boundary and config contracts are covered by the adjacent unit
tests. Startup reports an authentication-required state, and only explicit
Connect or Reauthorize passes the provider and its one-shot callback source to
the production host connection.

## MCP Apps sandbox and consent (BST-1572)

The real boundary is an in-page nested iframe inside the main window, NOT a
separate Electron WebContents or session partition: Electron never creates a
WebContents for an in-page `<iframe>`, so no `web-contents-created` /
session-level policy can ever observe an app frame.

**The Apps host is not unconditionally present (BST-1604).** It ships ON, but a
global Settings switch and a per-server `"extensions": { "apps": false }` entry
in the MCP configuration document each turn it off. With Apps off for a server
the client never advertises `io.modelcontextprotocol/ui` on that connection, so
no conformant server returns an app resource; the change advances that server's
connection generation, which drops its run-detached admissions, and the visible
renderer's enablement provider unmounts every mounted app for it through the
ordinary teardown below (frame bridge close, tool-call authority close,
generation retirement, sandbox shell release — the shell URL 404s immediately).
Nothing else in this section is conditional: the session policy below is
installed on `session.defaultSession` for the whole process regardless of the
dials, so a stale or racing frame can never regain a permission or a download.

- **App frame.** The untrusted app document is an `about:srcdoc` iframe with
  `sandbox="allow-scripts"` (opaque origin; no `allow-same-origin`,
  `allow-popups`, `allow-downloads`, `allow-forms`, or `allow-top-navigation`)
  and `allow` = every reviewed permission set to `'none'`. Its document starts
  with a host-owned doctype and a per-document CSP meta tag built from the
  resource's validated `_meta.ui.csp` (`default-src 'none'`, no
  `unsafe-eval`, `form-action 'none'`, `worker-src 'none'`, connect/frame/
  resource domains only as declared).
- **Shell.** The app frame is created by a host-authored shell document whose
  sole script is a literal bootstrap. The renderer renders the shell
  (`McpAppSandboxOwner`) and registers it through `window.mcp.apps.prepareShell`;
  main serves it at `brainstrike-mcp-app://<128-bit token>/` from a privileged
  standard scheme (`apps-shell-protocol.ts`), so every shell has an origin of
  its own — never the host renderer's — and receives the app policy as REAL
  `Content-Security-Policy` and `Permissions-Policy` response headers (the
  nested srcdoc inherits a header policy; `Permissions-Policy` is header-only).
  `setup-security.ts` exempts the scheme from the global header stamp exactly
  like the Canvas shell. The main window's own CSP allows
  `frame-src brainstrike-canvas: brainstrike-mcp-app:` only; `blob:` is never a
  frame source (a blob shell would run on the host origin with no header CSP
  and is blocked by that directive).
- **Fenced lifetime.** Each shell is bound to the registering WebContents id
  (only that sender may `releaseShell`); release makes the URL answer 404
  immediately, WebContents destruction drops every shell it registered, and
  the renderer owner releases on unmount, on generation retirement, and on a
  teardown that races an in-flight registration.
- **Frame bridge fencing.** Host↔app messages are fenced by origin (`null`),
  by the bound app-frame `source` (reached as the cross-origin shell's first
  child window; the shell document itself is unreachable from the host), and
  by generation; anything else is a protocol error that tears the mount down.
- **Navigation.** The main window's `setWindowOpenHandler` denies popups from
  every frame and `will-navigate` guards the main frame; `will-frame-navigate`
  (`apps-frame-navigation.ts`) denies the shell frame any navigation and the
  app frame anything but its own `about:srcdoc` load.
- **Session policy (BST-1599).** The app frame runs in the main window's
  session, so the `allow` attribute and the shell's `Permissions-Policy`
  header cannot be the whole story: they only govern Permissions-Policy
  features. `notifications` is not one, and with no session handler installed
  Electron's default GRANTS every permission request — measured on
  Electron 43, `Notification.requestPermission()` from the opaque app document
  resolved `granted`. `installMcpAppSessionPolicy`
  (`src/mcp/apps-session-policy.ts`, wired from `setup-security.ts` onto
  `session.defaultSession`) closes that:
  - `setPermissionRequestHandler` / `setPermissionCheckHandler` DENY every
    permission whose `details.requestingUrl` is an opaque-origin sandbox shell
    (`brainstrike-mcp-app://` or the Canvas shell `brainstrike-canvas://`), or
    is `about:srcdoc` while the requesting WebContents hosts an `about:srcdoc`
    frame whose parent is such a shell. Electron reports no frame handle and
    no usable origin for the opaque app document (`requestingOrigin` is empty;
    `embeddingOrigin` is the TOP frame's), so the srcdoc arm is resolved from
    the frame tree and is deliberately fail-closed. Both sandboxes are covered
    because Electron cannot say WHICH srcdoc frame asked: covering only one
    would make the other's posture depend on whether an MCP App happened to be
    mounted, and neither sandbox has any legitimate use for a permission (the
    Permissions-Policy features are already denied by the frame `allow`
    allowlist, so the arm's real subjects are `notifications` and
    `openExternal`, which neither may have).
  - `details.requestingUrl` is REQUIRED on the request handler but OPTIONAL on
    the CHECK handler — Electron omits it "for cross-origin sub frames making
    permission checks", which is exactly what an opaque sandbox document is,
    and APIs that check before requesting never reach the request handler at
    all. An unattributable SUB-frame check is therefore DENIED whenever the
    requesting WebContents hosts a sandbox frame, mirroring the srcdoc arm; a
    main-frame check (`details.isMainFrame`) is never the sandbox and keeps
    Electron's default. The host renderer's frames are never `about:srcdoc`,
    never carry a shell scheme, and its main frame always reports
    `isMainFrame`, so the predicate cannot deny it, and nothing is denied at
    all while no sandbox is mounted. Every other requester keeps Electron's
    default outcome, so the host renderer is unchanged; the browser pane has its
    own partition and its own
    deny-by-default handlers.
  - Each denial is logged at `warn` ONCE per (WebContents, arm, permission).
    A permission status read is synchronous, needs no user gesture, and the
    denial is silent to the page, so an unthrottled log line would let
    untrusted content dictate the write rate of the user's on-disk log. The
    permission name is a closed Electron enum and there are two arms, so the
    key space is bounded per WebContents while every distinct denial is still
    recorded the first time it happens.
  - `will-download` cancels any download whose URL chain carries a shell
    origin — `brainstrike-mcp-app://…` or the `blob:brainstrike-mcp-app://…`
    a shell frame minted. Electron reports no frame for a download, and a blob
    URL is the only carrier of the initiating origin; the packaged host
    renderer's own blobs are `blob:brainstrike-app://bundle/…` and are
    untouched. The app
    document cannot reach `will-download` at all — its sandbox is exactly
    `allow-scripts`, and without `allow-downloads` Chromium blocks the
    download first (measured, and asserted by the packaged lane). The Canvas
    shell needs no download arm: unlike the MCP App shell (a real origin in an
    UNSANDBOXED iframe), it is itself `sandbox="allow-scripts"`, so Chromium
    blocks its downloads before the session ever sees them.
  Pinned by `src/__tests__/main/mcp-apps-session-policy.test.ts` and by the
  packaged lane's live probe, which exercises the request path
  (`Notification.requestPermission()`) AND the check path
  (`Notification.permission` + `navigator.permissions.query`) from the app
  frame, the shell frame and the host renderer (see below).
- App-originated calls use strict prepare/execute/release messages over the
  visible-UI-only `mcp:apps:*` IPC domain. Every prepare names the persisted
  thread that owns the app's tool result; main resolves only THAT thread's
  admission (never the most recent run that knows the same server), requires
  it to admit the server, and binds the one-use executor to the requesting
  WebContents. While the owning run is live the executor is the run's gated
  tool entry; after the run's turn ends the admission is detached: the same
  static allow/ask decision and risk category still gate the renderer consent
  dialog, and execution is a single `tools/call` on the process-level MCP host
  port for the exact configured server and server-side tool name, pinned to
  the host generation live at detach time. Detached calls carry no run hooks
  or telemetry. Missing admission (a thread with no run ever, a detached
  admission whose server generation retired or server was removed, or a host
  that closed), malformed input, replay, release, supersession by a newer run
  of the thread, and WebContents destruction all fail closed.
- An MCP App's document is read through the agent host's desktop-only,
  generation-fenced `mcp/content/read` method (public-socket clients are
  refused) and is used only when an exact `text/html;profile=mcp-app` MIME type
  and text body are present.
  `window.mcp.apps.prepareShell` / `releaseShell` are the visible-UI-only
  `mcp:apps:prepareShell` / `mcp:apps:releaseShell` channels (strict schemas;
  per-sender and per-document size limits fail closed).
- The packaged proof (`e2e/mcp-apps-production-lifecycle.desktop.test.ts`, in
  `test:e2e:lane:packaged-mcp`) mounts an app inside
  the REAL main window — production preload, default session, header CSP — and
  asserts that a `blob:` frame is blocked, the served shell loads and
  handshakes, the frame fence holds, the shell URL is 404 after release, and
  that a permission request from the app frame and a download from the shell
  frame are both denied while the host renderer's are not.

## macOS code signing and notarization (BST-1627)

Release DMGs are signed with the owner's **Developer ID Application**
identity and notarized through an App Store Connect API key; the packaged
app carries a stapled notarization ticket so Gatekeeper accepts a quarantined
download offline. The DMG container itself is deliberately unsigned
(electron-builder default; Gatekeeper assesses the app inside it).

- **Hardened runtime + entitlements.** `build.mac.hardenedRuntime` is on and
  `signing/entitlements.mac.plist` is the complete, tracked entitlement set:
  `allow-jit` and `allow-unsigned-executable-memory` for V8, and
  `disable-library-validation` because the bundle loads code not signed by our
  Team ID (the Electron framework, `node-pty` prebuilds,
  `@brainstrike/secure-fs-native` addon under
  `app.asar.unpacked`, and the bundled CPython). The app is NOT App-Sandboxed;
  no `app-sandbox` / `files.*` keys exist and none may be added "just in case".
- **Bundled CPython ships as loose, signed files.** Apple's notarization
  service scans inside archives and rejects python-build-standalone's
  ad-hoc-signed Mach-O files, so `scripts/fetch-python-runtime.mjs` unpacks the
  verified tarball at BUILD time into
  `resources/python-runtime/unpacked/darwin-<arch>/` and `extraResources`
  copies that tree (never a `.tar.gz`) into `<Resources>/python-runtime`, where
  osx-sign re-signs its Mach-O files with the Developer ID. The runtime
  resolver only verifies the tree's sentinel against the manifest sha256;
  nothing is extracted or written under `userData`, and every launch sets
  `PYTHONDONTWRITEBYTECODE=1` so no run writes `__pycache__` into the signed
  bundle.
- **Credentials never enter the repository or the config.** Signing and
  notarization are env-driven (`CSC_LINK`/`CSC_KEY_PASSWORD` for the `.p12`,
  `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` for notarytool). The
  root `.gitignore` refuses `*.p12`, `*.p8`, `*.cer`, `*.provisionprofile`
  and `AuthKey_*`. In CI the `.p8` is materialised as a mode-0600 file under
  `RUNNER_TEMP` only for the packaging step and removed afterwards; locally
  `APPLE_KEYCHAIN_PROFILE` (a `notarytool store-credentials` profile) is used
  instead so no key file exists on disk.
- **Evidence gate.** The release workflow fails each macOS leg (arm64 and
  x64, each on its own native runner) unless the
  packaged app passes `codesign --verify --deep --strict`, reports a
  `Developer ID Application` authority, carries the entitlements above, has a
  stapled ticket (`xcrun stapler validate`), and is assessed by `spctl -a -t
  exec` as `source=Notarized Developer ID`. When `CSC_LINK` is absent, or a
  dispatch asks for `unsigned`, the workflow passes no signing or notarization
  secret to the build, builds the documented unsigned posture, and asserts no
  Developer ID signature is present, so a build is never half-signed.

## Logging, DevTools and updates

- Packaged builds log at `info` unless `LOG_LEVEL` or Settings › Logging says otherwise.
- DevTools open from View › Toggle Developer Tools in every build.
- Renovate opens dependency and Electron updates (`.github/renovate.json5`).

## References

- [Electron security guidelines](https://www.electronjs.org/docs/tutorial/security)
- [Content Security Policy (MDN)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [OWASP Electron security](https://owasp.org/www-project-electron-security/)
