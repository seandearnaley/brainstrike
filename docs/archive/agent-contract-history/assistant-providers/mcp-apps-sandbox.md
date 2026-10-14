# MCP Apps sandbox and session policy — evidence

Supports `docs/agents/assistant-providers.md` § "Production Apps host". The in-page iframe boundary, the shell scheme, and the Electron session permission policy.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2954-3018); append rather than
rewrite.

---

`registerMcpAppsClientCapability` defines the capability-only
`io.modelcontextprotocol/ui` contract at stable revision `2026-01-26`. It has
no extension requests or notifications and works on legacy-era connections.
`createDefaultMcpExtensionRegistry` registers it beside Tasks on every fresh
stdio or streamable-http generation; legacy `sse` receives no registry.
Initialize advertises exactly
`{ mimeTypes: ['text/html;profile=mcp-app'] }`.

**Sandbox boundary (settled; do not reintroduce a partition).** The app is an
in-page nested iframe in the main window; Electron never creates a WebContents
for an in-page `<iframe>`, so a `web-contents-created` / session-partition
policy can never observe it (the earlier `mcp-app:thread` wiring was dead code
and was removed). The boundary is: an opaque-origin `about:srcdoc` app frame
with `sandbox="allow-scripts"`, a per-document CSP meta tag, and `allow` set
to `'none'` for every reviewed permission — created by a host-authored shell
that the renderer renders (`McpAppSandboxOwner.open` → `renderMcpAppSandboxShell`)
and registers over `window.mcp.apps.prepareShell`. Main serves the shell at
`brainstrike-mcp-app://<token>/` (`apps/desktop/src/mcp/apps-shell-protocol.ts`:
privileged `standard: true` scheme → one origin per shell, never the host
origin; the app policy delivered as `Content-Security-Policy` AND
`Permissions-Policy` RESPONSE HEADERS, which the nested srcdoc inherits;
uniform 404 for unregistered/released tokens, 405 for non-GET; exempt from the
`setup-security` header stamp like `brainstrike-canvas:`; registered in the
single `registerSchemesAsPrivileged` call). The main window's CSP is
`frame-src brainstrike-canvas: brainstrike-mcp-app:` — `blob:` is never a
frame source. Shells are bound to the registering WebContents id
(`apps-shell-bridge.ts`: only that sender may release; destruction drops all
of its shells) and `releaseShell` is immediate. The renderer reaches the app
frame as the cross-origin shell's first child window (`frame.contentWindow[0]`);
the shell document is unreachable. `will-frame-navigate`
(`apps-frame-navigation.ts`, wired in `create-window.ts`) denies the shell any
navigation and the app frame anything but `about:srcdoc`.

**Session policy (BST-1599).** `allow` + `Permissions-Policy` only govern
Permissions-Policy features; `notifications` is not one, and with no session
handler Electron 43 GRANTS it to the opaque app document by default.
`installMcpAppSessionPolicy` (`apps/desktop/src/mcp/apps-session-policy.ts`,
wired from `setup-security.ts` onto `session.defaultSession`) denies every
permission request AND check whose `details.requestingUrl` is an opaque-origin
sandbox shell (`brainstrike-mcp-app://` or the Canvas shell
`brainstrike-canvas://`), or is `about:srcdoc` while the requesting WebContents
hosts an `about:srcdoc` frame parented by such a shell. Electron exposes no
frame handle and no usable origin for the opaque app document, so the srcdoc
arm resolves the parent from the frame tree and is fail-closed; both sandboxes
are covered because Electron cannot say WHICH srcdoc frame asked, and covering
only one would make the other's posture depend on whether an MCP App happened
to be mounted. `details.requestingUrl` is REQUIRED on the request handler but
OPTIONAL on the check handler (Electron omits it for cross-origin sub frames —
exactly what the sandbox is) and APIs that check before requesting never reach
the request handler, so an unattributable SUB-frame check is DENIED whenever
the WebContents hosts a sandbox frame; `details.isMainFrame` keeps the host
renderer's own checks on Electron's default. Denials log at `warn` once per
(WebContents, arm, permission): untrusted content can read permission status in
a tight loop, and the log is on the user's disk. `will-download` cancels any
download whose URL chain carries an MCP App shell origin
(`brainstrike-mcp-app://…` or the `blob:brainstrike-mcp-app://…` a shell frame
minted); the app document itself cannot reach `will-download` because its
sandbox is exactly `allow-scripts`, and neither can either Canvas layer, which
is why the download arm stays MCP-App-only. Every other requester keeps
Electron's default outcome, so the host renderer, the hidden renderer hosts,
and the browser pane's own partition (`browser/browser-session.ts`) are
unchanged. Pinned by
`src/__tests__/main/mcp-apps-session-policy.test.ts` and a live probe in
`test:e2e:lane:packaged-mcp-apps` that drives both the request and the check
path.
