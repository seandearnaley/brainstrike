# Browser Tab + Canvas Surfaces — Research (2026-08-06)

Goal: add a canonical, modern **agent-drivable browser tab** and a **canvas/artifact surface** to BrainStrike, matching the feature bar set by Claude Code desktop, Cursor 2.0, and Codex. This doc records the commercial feature baseline, the open-source building blocks, BrainStrike integration seams, and the recommended stacks — input for Linear ticket creation.

---

## 1. What "canonical" means in 2026 (commercial baseline)

These are **two distinct subsystems** that share a pane shell but have opposite security models: the browser needs real web access; the canvas needs strict no-network sandboxing.

### Browser pane — the field

| App | Surface | Seeing model | Driver (known/inferred) | Identity model |
| --- | --- | --- | --- | --- |
| Claude Code desktop (W28 2026) | Dockable pane, multi-tab, shared live view | **A11y-tree-first** (`read_page` YAML tree with `ref_N` handles) + screenshots; clicks accept coordinate *or* ref | Electron WebContentsView + CDP (inferred) | Clean profile; per-origin approval cards; separate Chrome extension for logged-in life |
| Cursor 2.0 | Inline pane or window; screenshots render in chat | Screenshot-first, 6 verbs | Editor webview + MCP bridge | **Per-workspace persistent** profile (agent stays logged in to staging) |
| Codex desktop | Shared view; **annotation mode** (user comments on rendered elements → agent instructions) | Screenshot + DOM inspect | Embedded Chromium | No auth at all |
| Windsurf/Devin | Preview panel + "Send element" picker (works even in external browser) | Element forwarding | Injected listeners | — |
| Replit Agent 3 | Preview pane; autonomous headless self-test loop | Proprietary | Headless browser | — |

Cross-cutting: the a11y-tree/ref model is cheaper in tokens and more deterministic than screenshot-first; the strongest design (Claude's) offers both. Dev-server integration ranges from "detect running servers" (Cursor) to full declarative lifecycle (`launch.json` start/logs/stop — Claude). User→agent annotation (Codex/Windsurf) is the emerging differentiator.

### Canvas — two lineages

1. **Sandboxed render** (Claude Artifacts): single-file HTML/React/SVG/mermaid in a sandboxed iframe on a separate origin, strict CSP (no external network), create/update(string-replace)/rewrite tool verbs, version stepper, publish/share.
2. **Editable document** (ChatGPT Canvas / `canmore`): a co-owned text/code buffer; agent edits via pattern-replacement updates and **anchored comments**; user edits interleave; version stepping; run/preview for code/HTML.

A complete implementation eventually needs both halves.

### Canonical feature checklist (tiered)

**Browser MVP**: embedded Chromium pane (live shared view), navigate/back/forward, screenshot, click/type/scroll/key, a11y-tree read with stable refs, find-in-tree, get_page_text, form_input by ref, console read, network list + response body, dev-server launch/attach/logs/stop (localhost exempt from approval), per-origin first-contact approval, clean profile, hard-blocked credential/payment/CAPTCHA actions.
**Browser v2**: multi-tab, dual coordinate/ref addressing, viewport presets + colorScheme emulation, zoom region screenshots, JS eval (inspection-only), opt-in persistent profile, external-link chooser in chat, permission modes.
**Browser advanced**: element-picker annotation → agent context, HAR capture, companion extension for authed sessions, autonomous self-test loops, GIF capture.

**Canvas MVP**: side-panel render of HTML/markdown/SVG/mermaid in sandboxed iframe + strict CSP, create/update/rewrite tools keyed to stable identity, version history + rollback, theme-aware, default-private.
**Canvas v2**: editable-document mode with anchored agent comments, React tier with pinned lib set, conflict detection (baseVersion/409), share URLs.
**Canvas advanced**: opt-in runtime capabilities (agent-mediated AI calls, scoped MCP access), remix/fork, per-artifact origin isolation (avoid the Cowork shared-origin weakness).

---

## 2. Open-source building blocks

### Browser pane stacks (verdicts as of 2026-08-06)

**Surface: Electron `WebContentsView` is the only serious answer.** `<webview>` tag is discouraged by Electron itself; `electron-tabs` is discontinued (and webview-based); BrowserView is deprecated. Pattern: one WebContentsView per tab, React placeholder `<div>` + ResizeObserver → IPC → `setBounds()`. Known cost: the native view paints **above all renderer DOM** — dialogs/menus must avoid its rect or the view hides while modal UI is up.

**Driver — the pivotal choice:**

- **Stack A (recommended): `playwright-core` → `connectOverCDP`** against our own `remote-debugging-port` (127.0.0.1). Each WebContentsView appears as a page target; we inherit auto-waiting clicks, locators, `ariaSnapshot()`/`_snapshotForAI()` (the `[ref=eN]` model, de-facto stable — playwright-mcp depends on it), screenshots, network/console events. Apache-2.0, massively maintained. **Risks**: Playwright↔Electron-Chromium version skew (officially "experimental"; pin versions, test on Electron upgrades); local debug port is an attack surface (bind 127.0.0.1, lock down). Build ~30% (tab/bounds manager, tool schemas, target↔tab map) / buy ~70%.
- **Stack B (fallback/end-state): raw `webContents.debugger`** + `devtools-protocol` types. In-process CDP, no port, zero version skew forever. We rebuild input synthesis, waiting, and the a11y-ref serializer (~1–2 wks careful work; copy vercel-labs/agent-browser's `@eN` snapshot spec). Conflicts with opening DevTools on the same view. Build ~70%.
- **Stack C (non-goal for mainline): sidecar real Chrome + `chrome-devtools-mcp`** (Google, Apache-2.0, 48.6k★). Officially supports Chrome/Chrome-for-Testing only; attach-to-existing is flaky; browser isn't *in* the app. Possible later power-mode only.

Design decision: keep the **tool layer driver-agnostic** so hot paths can migrate A→B if skew bites.

**Frameworks assessed**: Stagehand (MIT, can attach to our CDP endpoint via `localBrowserLaunchOptions.cdpUrl` — optional later for NL `act()` tools; brings its own LLM layer we don't need next to Mastra); browser-use (Python, read-only inspiration); Magnitude (parked); Skyvern/BrowserOS (**AGPL** — no code reuse); Nanobrowser (Apache-2.0, cooling; planner/executor split worth reading); electron-browser-shell (**GPL-3.0** — architecture reference only); Dyad (closest OSS "React shell + dev-server preview pane", license has proprietary carve-out). **Nobody has shipped the exact composite in OSS.**

**Page reading**: Playwright `ariaSnapshot`/`_snapshotForAI` (free with Stack A); or CDP `Accessibility.getFullAXTree` + own serializer (~300–500 lines, Stack B); `dom-to-semantic-markdown` (MIT) for the `get_page_text` analog.

### Canvas stacks

- **LangChain Open Canvas: archived Feb 2026.** Design reference only (versioned artifact model, quick actions, selection-scoped rewrites).
- **Render sandbox (recommended): own two-layer shell design** *(corrected per review; implemented in PR #2290)*. A plain `srcdoc` iframe does NOT work here: `about:srcdoc` (like `about:blank`/`blob:`/`data:`) is a local scheme, so the canvas document **inherits the app's CSP** — and our prod `script-src` has no `unsafe-inline`, so inline canvas scripts would work in dev and silently die in prod; an injected meta CSP can only narrow an inherited policy, never relax it, and `frame-src` plays no role in local-scheme frames. The working design: a trusted static **shell** document served from a real origin with its OWN strict CSP header (desktop: `brainstrike-canvas:` protocol + a scheme exemption in `setup-security`'s global header stamp, which otherwise re-imposes `X-Frame-Options: DENY`; web: `/canvas-frame.html` with per-path header overrides in vite dev middleware + vercel.json). The host frames the shell with `sandbox="allow-scripts"` (no `allow-same-origin` → opaque origin), and the shell hosts canvas content in a nested `srcdoc` iframe — inheritance then works FOR us, handing canvas content the reviewed sandbox policy (inline execution, zero network). Willison's Apr 2026 research still underwrites the meta-CSP layer as defense-in-depth. postMessage bridge validates `event.source` + a per-mount fragment nonce. Electron extra hardening: deny `openExternal` (CVE-2026-70612), optional `webRequest` no-network kill-switch. React/TSX tier: compile in a worker via `esbuild-wasm` (MIT), vendored React 19 + allowlisted libs — **fully offline**, zero cloud, zero license risk.
- **Chrome/UX to borrow**: Vercel **AI Elements** (Apache-2.0, shadcn-vendored `Artifact`/`WebPreview`/`CodeBlock` chrome — note their "Canvas" is a workflow graph, not an artifact canvas); Vercel **Chat SDK** (`vercel/chatbot`, Apache-2.0) — the best end-to-end OSS artifacts reference (ProseMirror/CodeMirror editors, delta streaming, version history + diff, selection quick-prompts); **port, don't depend** (Next.js-coupled).
- **assistant-ui Interactables** (`unstable_useInteractable`): we already ship `@assistant-ui/react` — Interactables provide shared user↔model editable state, auto-generated `update_*` tool, streaming partial updates, built-in versioning/`restore()`, side-panel or thread-scoped mounting. Closest ready-made Canvas state layer; `unstable_` API churn is the risk. Their **SafeContentFrame** (content-hashed cross-origin iframe host) is directly relevant prior art.
- **Rejected**: Sandpack (stale since Apr 2025; Nodebox templates need commercial license; LibreChat's self-hosted-bundler fork proves the pattern if ever needed), WebContainers (paid commercial license), e2b Fragments (cloud sandbox — local-first violation; UX reference only), srcbook (dormant), BlockNote `xl-ai` (**GPL-3.0** or paid; core is MPL-2.0 and fine).
- **Mermaid**: never `securityLevel: 'loose'` (real XSS advisories via `click` directive); render inside the artifact iframe where CSP contains it (also sidesteps mermaid's sandbox-mode dark-mode wart). We already have `mermaid-block.tsx` with `strict`.

---

## 3. BrainStrike integration seams (verified in-repo)

Full detail in the exploration report; the load-bearing facts:

1. **Surface registration** — two registries: top-level `PanelTab` union ([panel-layout-store.ts:27](../packages/app-state/src/stores/panel-layout-store.ts)) + `RootLayoutContentProps` optional-ReactNode pattern ([root-layout-content.tsx:151](../packages/app-shell/src/root-layout-content.tsx)); or `WorkspaceApp`/`extraApps` in the workspace tab host ([workspace-tab-host.tsx](https://github.com/seandearnaley/brainstrike/blob/d80ef9e276e88722c0e0e5f4c71c92fb01d46d42/packages/file-explorer-ui/src/shell/workspace-tab-host.tsx)) — the likely home for a canvas tab next to Changes.
2. **Capability gating** — desktop composer + a dependency-light `availability.ts` per feature (template: `packages/app-shell/src/changes/availability.ts`); web simply never constructs the prop. No `isElectron()`, no stubs.
3. **Electron window architecture** — no WebContentsView/BrowserView/webview anywhere today; `configureSecurity()` in `apps/desktop/src/create-window.ts:52` denies all non-self navigation (the browser pane needs its own view + a new `window-role.ts` role, exempt from that lockdown); `renderer-host-lifecycle.ts` is a reusable construction/crash-retry harness.
4. **IPC** — new domain in `DesktopIpcDomain` union + `ipc-<domain>.ts`/`<domain>-ipc-handlers.ts` pair (template: `ipc-changes.ts`), preload bridge via `shouldExposeBridge`.
5. **CSP (BST-745)** — single source `packages/platform-utils/src/content-security-policy.ts`. *(Corrected per review:)* the canvas blocker is not a missing `frame-src` but **CSP local-scheme inheritance** — a `srcdoc`/`blob:` canvas frame inherits the app policy (prod `script-src` has no `unsafe-inline`), which an injected meta CSP can only narrow. Escaping inheritance requires a real separate origin for the shell (custom scheme on desktop, dedicated path + per-path headers on web); `frame-src` is then only what *admits* that shell into the page. Shell-origin isolation is therefore an **MVP prerequisite**, not "Canvas advanced" hardening. Landed in PR #2290 with the three pinning suites updated.
5b. **Global response-header stamp (`apps/desktop/src/setup-security.ts:24`)** — *(promoted to its own seam per review)*: `onHeadersReceived` on `session.defaultSession` overwrites CSP + `X-Frame-Options: DENY` + a camera/mic/geolocation-denying `Permissions-Policy` on EVERY response with no URL filtering. Consequences: (a) the Canvas shell needed an explicit scheme exemption (PR #2290); (b) for the **browser pane** (BST-1174), any WebContentsView on the default session would get `default-src 'self'` stamped over every real site — pages would half-render confusingly — so a **non-default session partition is a correctness requirement**, not just clean-profile hygiene, and the Permissions-Policy stamp matters if dev-server pages ever need camera/mic.
6. **Tool registration is a 10-place multi-registry** (parity-tested, no partial registration): `native-tool-catalog.ts` → descriptions → categories/risk → display schemas → discovery → `packages/agent/src/tools/schemas.ts` → `assistant-tools.ts` (execution) → preference/permission stores → instructions → approval/render UI. Browser tools inherit guard→hooks→permission pipeline automatically.
7. **MCP host exists** (`apps/desktop/src/mcp/`, official SDK, stdio/http/sse) — could host chrome-devtools-mcp unmodified, but that's Stack C.
8. **WebContentsView z-order hazard**: paints above all DOM; `packages/ui/src/layers.ts` tokens cannot arbitrate it — pane must hide (or the layout must avoid overlap) whenever dialogs/popovers/toasts open. This is the main UI-conventions collision.
9. **Persistence/reset**: browser session partition, per-origin grants, and canvas document tables must register in factory reset (`factory-reset.ts`, `reset-table-registry.ts`); Electron partition under `userData` is wiped for free, renderer-side stores are not.
10. **Naming collision**: **"artifact" is taken** — `tool-output-artifact.ts` = paged tool output (migration 068, `brainstrike.readToolOutputArtifact`). The canvas feature needs a different name (e.g. "Canvas").

Existing precedents to reuse: `brainstrike-asset:` protocol (custom-scheme serving), `mermaid-block.tsx` (only sanctioned `dangerouslySetInnerHTML`), markdown-surface inert-HTML tests, terminal panel (the template for a desktop-only, capability-gated, keep-mounted surface), assistant-ui panel wrappers (~110 modules over `@assistant-ui/react`).

---

## 4. Recommended options

### Option 1 — Browser pane: WebContentsView + playwright-core over CDP (driver-agnostic tool layer)
The mainline recommendation. Electron-native surface, battle-tested driver, a11y-ref seeing model for free. Desktop-only (web omits the capability per convention). Est. **4–6 weeks** across: view/tab/bounds manager + shell UI (~1.5 wk), driver + tool layer + multi-registry registration (~1.5 wk), permission/origin-approval + clean-profile session + factory reset (~1 wk), dev-server preview integration (~1 wk, can reuse terminal/command-session infra). Migration path to raw `webContents.debugger` (Stack B) if Playwright/Electron skew becomes a tax.

**Accepted trade-off (recorded per review): the CDP debug port is unauthenticated.** Loopback binding only excludes remote hosts — any local process running as the user can attach full CDP to the pane (read cookies/localStorage of visited origins, evaluate arbitrary JS). There is no clean in-stack mitigation: the port cannot be authenticated and an ephemeral port is obscurity, not access control. This is acceptable while the pane profile is throwaway/clean, and it is a second, independent argument for Stack B beyond version skew (in-process, no port). Consequence: the **opt-in persistent per-workspace profile (Browser v2, BST-1179) is gated on the A→B driver migration** — a persistent profile over an open port would expose real logged-in sessions.

### Option 2 — Canvas (render tier): own sandboxed iframe + meta-CSP + esbuild-wasm
Build the sandbox (it's small and the security posture demands owning it), borrow the chrome (AI Elements) and the flow blueprint (Chat SDK). Works identically in desktop **and web** (unlike the browser pane). HTML/SVG/mermaid/markdown first; React tier via esbuild-wasm + vendored libs second. Est. **2–3 weeks** for MVP incl. CSP extension, tool verbs (create/update/rewrite), versioning, reset wiring.

### Option 3 — Canvas (editable-document tier, v2): assistant-ui Interactables + CodeMirror/ProseMirror
Deferred until the render tier lands. Interactables give co-owned state/versioning/auto-update-tool; Chat SDK is the porting blueprint for delta-streaming editors + diff view. Est. **2–3 weeks**. Watch the `unstable_` API.

### Explicitly not recommended
`<webview>`/electron-tabs/puppeteer-in-electron (dead/discouraged), AGPL codebases (Skyvern, BrowserOS) for code reuse, WebContainers (license), e2b runtime (cloud), Sandpack as a dependency (stale), Open Canvas (archived), chrome-devtools-mcp as the mainline driver (sidecar-Chrome UX, unsupported target).

### Suggested ticket decomposition (pending approval)
1. **Canvas MVP** (render tier, desktop+web): sandbox component + CSP extension + tool verbs + versioning + reset. Independent of everything else; smallest risk; immediately user-visible.
2. **Browser pane shell**: WebContentsView tab manager, window role, bounds sync, z-order policy, nav-rail surface, capability bridge.
3. **Browser agent tools**: CDP driver, tool layer (navigate/screenshot/click/type/snapshot/console/network), multi-registry registration, approval UI.
4. **Browser permission & profile model**: per-origin grants, clean-profile session partition, localhost exemption, factory reset.
5. **Dev-server preview integration**: launch-config, attach, logs, stop.
6. **Canvas v2 editable-document mode** (Interactables) — later.
7. **Browser v2** (multi-tab, emulation, annotation picker) — later.

Stacking: 2→3→4 are naturally layered; 1 and 5 are independent.

---

## Sources
Commercial: Claude Code W28 docs · digitalapplied.com Claude-browser deep-dive · cursor.com/docs/agent/tools/browser + 2.0 changelog · canmore tool defs (edoardoavenia/chatgpt-system-prompts) · Codex browser-use analyses · Bloom Security on Artifacts · code.claude.com/docs/en/artifacts · Windsurf/Devin previews docs · Replit Agent 3 · firebase.google.com/docs/studio/preview-apps.
OSS: electronjs.org WebContentsView/webview/web-embeds/security/debugger docs · playwright.dev connectOverCDP + aria-snapshots · github.com/ChromeDevTools/chrome-devtools-mcp · browserbase/stagehand · vercel-labs/agent-browser · samuelmaddock/electron-browser-shell · dyad-sh/dyad · assistant-ui docs (interactables, mcp-apps) · vercel/ai-elements · vercel/chatbot · danny-avila/LibreChat (self-hosted Sandpack pattern) · simonwillison.net Apr-2026 CSP-iframe-escape research · blocknotejs.org AI reference · labs.snyk.io diagram-renderer exploits · CVE-2026-70612.
