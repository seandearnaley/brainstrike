# Security Implementation for BrainStrike Desktop

This document outlines the security measures implemented in the BrainStrike Desktop Electron application.

## Content Security Policy (CSP)

### Overview
The application implements a comprehensive Content Security Policy that differs between development and production environments.

### Development CSP
- Permits connections to localhost for the development server
- Enables WebSocket connections for live reload
- Allows `'unsafe-inline'` scripts to support Vite Hot Module Replacement (HMR)

### Production CSP
- Stricter policy without `unsafe-eval`
- Only allows connections to self
- Blocks all external resource loading except explicitly allowed

### CSP Directives
- `default-src 'self'`: Only allow resources from same origin
- `script-src`: Controls JavaScript execution
- `style-src 'self' 'unsafe-inline'`: Allows inline styles for CSS frameworks
- `img-src 'self' data: blob:`: Allows images from self, data URLs, and blobs
- `font-src 'self' data:`: Allows fonts from self and data URLs
- `object-src 'none'`: Blocks all plugins
- `base-uri 'self'`: Restricts base tag URLs
- `form-action 'self'`: Restricts form submissions
- `frame-ancestors 'none'`: Prevents embedding in frames

## Additional Security Headers

### X-Content-Type-Options
- Set to `nosniff` to prevent MIME type sniffing

### X-Frame-Options
- Set to `DENY` to prevent clickjacking attacks

### X-XSS-Protection
- Set to `0` to disable the legacy XSS auditor, which can itself introduce vulnerabilities. Modern CSP provides superior XSS protection.

### Referrer-Policy
- Set to `strict-origin-when-cross-origin` for privacy

### Permissions-Policy
- Disables camera, microphone, geolocation, and payment APIs

## Electron Security Settings

### WebPreferences
- `nodeIntegration: false`: Disables Node.js in renderer
- `contextIsolation: true`: Isolates context between main and renderer
- `webSecurity: true`: Enables web security features
- `sandbox: false`: Disabled to allow IPC communication
- `allowRunningInsecureContent: false`: Blocks mixed content
- `experimentalFeatures: false`: Disables experimental web features
- `safeDialogs: true`: Enables safe dialog handling
- `navigateOnDragDrop: false`: Prevents navigation on drag/drop

### Navigation Security
- Blocks navigation to external URLs
- Only allows navigation within the application
- Prevents opening new windows to external sites

### Window Security
- Uses preload script for secure IPC communication
- Implements secure context bridge for renderer communication

## IPC Security

### Preload Script
- Uses `contextBridge` to expose limited APIs
- No direct Node.js access in renderer process
- All file system and storage operations go through IPC

### Main Process Handlers
- Validates all IPC messages
- Implements proper error handling
- Uses typed interfaces for communication

## File System Security

### Directory Access
- Uses secure directory picker dialog
- Validates file paths before operations
- Implements proper error handling for file operations

### Storage Security
- Local storage adapter with validation
- No sensitive data stored in plain text
- Proper cleanup of temporary data

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
- Registers with the same fail-closed `{ roles: ['visible-ui'] }` policy as
  every other secrets channel — hidden renderer hosts (llm/embedding/chunking)
  and untracked senders are rejected before the handler runs, and the hidden
  preload exposes no `envBootstrap` bridge (contract test).
- The handler re-projects the RECORDED bootstrap result; it never re-runs env
  file loading, so this channel cannot be used to make the main process read
  files on renderer demand.

## Provider OAuth Subscription Auth (BST-1355)

Governed by the signed legal gate `docs/OAUTH_LEGAL_REVIEW_GATE.md`; its 8
constraints are binding. The engine lives in `apps/desktop/src/provider-auth/`
and runs ONLY in the Electron main process.

### Token store

- OAuth tokens are stored exclusively as typed `{ type: 'oauth', access,
  refresh, expires, accountId? }` credentials in the safeStorage-encrypted
  secrets store (`apps/desktop/src/secrets.ts`) — the same OS-keychain-backed
  store as API keys. A `basic_text` safeStorage backend is refused (typed
  `encryption_unavailable` error), never degraded to.
- Tokens never appear in logs, telemetry, run-error envelopes, RuntimeData, or
  RequestContext. Engine log lines carry provider ids and typed error codes
  only.
- Factory reset / `secrets clearAll` wipes engine-written OAuth credentials
  (guarded by `apps/desktop/src/__tests__/secrets.test.ts`).
- Refresh: single-flight per provider, 120s proactive skew, 30s per-request
  network timeout. A refresh rejected with `invalid_grant`/revoked marks the
  provider `reconnect_required`; the credential is kept until the user
  explicitly disconnects or reconnects — nothing is deleted silently and
  nothing retry-loops.
- Rotation-then-persist-failure recovery: once the provider accepts a refresh
  the old refresh token is dead, so if the local store write then fails the
  rotated pair is held IN MEMORY (process lifetime) as the active credential —
  the session keeps working — and the user is shown a
  `credential_persist_failed` status. The store's old value is left untouched.
  A later successful persist clears the in-memory copy and the status. After
  an app restart the stale STORED refresh token is rejected by the provider
  and the user lands in the normal `reconnect_required` path — the failure
  mode is a visible reconnect, never silent credential loss.
- Disconnect races: disconnect bumps a per-provider epoch before deleting the
  credential; a refresh completing under a stale epoch discards its result
  and persists nothing, so an in-flight refresh can never resurrect a
  credential the user just severed.

### Renderer boundary (tokens never cross IPC)

- The renderer's ONLY provider-auth surface is the `provider-auth` IPC domain
  (`start`/`cancel`/`status`/`disconnect`) returning token-free
  `ProviderAuthStatus` payloads. There is no IPC channel that can return token
  material to any renderer; tests pin the payload shape
  (`src/__tests__/provider-auth/provider-auth-ipc.test.ts`).
- Every provider-auth channel registers with the fail-closed
  `{ roles: ['visible-ui'] }` sender policy — hidden renderer hosts
  (llm/embedding/chunking) and untracked senders are rejected before argument
  parsing, and the hidden preload exposes no `providerAuth` bridge (contract
  test). This is the enforceable interactive-desktop-only constraint: OAuth
  subscription flows are structurally unavailable to headless, scheduled,
  server, or multi-user contexts, and the credential-resolution layer must
  call `assertInteractiveProviderAuthSender` (exported by
  `src/provider-auth/provider-auth-engine.ts`) before resolving an OAuth
  credential.

### Loopback callback hygiene

- Sign-in always uses the user's own system browser via the validated
  `shell.openExternal` path (http/https/mailto allow-list). Embedded webviews
  are never used for provider auth.
- The callback server binds `127.0.0.1` ONLY, on the provider-registered fixed
  port, exists only while a flow is in flight, and is torn down on the first
  result, cancel, or a 5-minute timeout. A busy port is a typed, visible
  `port_in_use` failure — never a random-port fallback.
- Requests must carry a Host of `127.0.0.1:<port>` or `localhost:<port>`;
  anything else (DNS rebinding) is refused with 400. Every response carries
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  script-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`, and
  `Referrer-Policy: no-referrer`.
- Authorization requests carry PKCE S256 (RFC 7636; crypto.randomBytes with
  rejection sampling) plus a 32-byte `state`. A callback whose state does not
  match is answered 400 and its code/error is DISCARDED — and the flow KEEPS
  WAITING for the legitimate state-matching callback, so an attacker who can
  reach the loopback port can neither complete nor terminate someone else's
  flow. Only a state-matching callback, the timeout, or an IPC-driven cancel
  settles the wait. Callback pages are fully self-contained HTML (no external
  assets) and never echo codes or tokens.
- There is NO HTTP cancel route: cancellation flows solely through the
  role-gated `provider-auth:cancel` IPC channel — an unauthenticated local
  HTTP request must not be able to cancel a sign-in.
- The RFC 8628 device flow polls with the server interval + safety margin,
  honors `slow_down`, and treats `expired_token`/`access_denied` as terminal.
- Every engine network call (token exchange, device start/poll, refresh) runs
  under the flow's AbortSignal plus a 30-second per-request timeout — a hung
  endpoint cannot wedge a flow, and cancel rejects a stalled call promptly.

### OpenAI Codex — ChatGPT subscription provider (BST-1356)

The first `oauth_subscription` provider. Descriptor:
`src/provider-auth/descriptors/openai-codex.ts`.

- **Own account only (gate constraint 1).** Brainstrike ships a sign-in FLOW,
  never credentials. Each user authenticates their own ChatGPT account on their
  own device.
- **No proxying (gate constraint 2).** Requests go device -> OpenAI directly.
  The fetch layer rewrites `/v1/responses` and `/chat/completions` onto
  `https://chatgpt.com/backend-api/codex/responses` — OpenAI's own host. No
  Brainstrike server exists in this path, and the product has no server that
  could pool or resell subscription traffic.
- **Interactive-desktop-only (gate constraint 4)** is enforced at the
  credential-resolution layer by TWO independent gates:
  1. *Structural* — `providerAuthInputFromCredential`'s oauth arm requires an
     injected `oauthSubscriptionFetch` capability. Only the interactive desktop
     assistant-server supplies one; web and any headless host inject nothing
     and the credential is REJECTED (typed `credential_type_unsupported`).
     A future headless mode would have to deliberately add the capability to
     break the constraint — no accidental refactor can.
  2. *Live* — `createInteractiveSubscriptionFetchFactory` re-checks per
     resolution (never captured once) that a `visible-ui` window exists, via
     `assertInteractiveProviderAuthSender`. The assistant server's own bearer
     token is already `visible-ui`-only (`assistant:get-auth` is role-gated),
     so this is a second lock on an already-bolted door — deliberately, because
     the gate requires the check at the credential-resolution layer.
  Pinned by `src/__tests__/provider-auth/subscription-fetch.test.ts` and
  `packages/assistant-service/src/__tests__/provider-credential-projection-oauth.test.ts`.
- **Honest identification (gate constraint 5).** `originator: brainstrike` on
  every request and in the authorize params — never another tool's originator
  string. The `User-Agent` is `brainstrike/<version> (<platform> <release>;
  <arch>)`. The OAuth client id is OpenAI's public Codex CLI registration, used
  per the ecosystem precedent recorded in the legal gate's Residual-risks
  section; revocation by OpenAI fails VISIBLY (typed error), never silently.
- **Token handling (gate constraint 3).** The access token lives only inside
  the per-request fetch closure, is applied as an `authorization` header, and
  is never logged, returned, or attached to anything outliving the call. The
  SDK's own dummy `apiKey` is stripped from the outgoing request in all three
  `HeadersInit` shapes before the real bearer is attached.
- **Factory reset.** Wiping `brainstrike-secrets.json` alone was NOT
  sufficient: a rotated pair whose store write failed lives in the refresher's
  in-memory overlay and would remain the ACTIVE credential for the process
  lifetime. `secrets clearAll` now also calls
  `purgeProviderAuthRuntimeState()`, which disconnects every registered
  descriptor (bumping its epoch and invalidating the overlay).
- **Data residency.** When rewriting to the Codex backend, a
  `chatgpt_compute_residency` claim on the ACCESS token is forwarded as
  `x-openai-internal-codex-residency` so region-constrained accounts route
  correctly. `no_constraint` sends no header.
- **Rate limits (gate constraint 6).** Subscription quota responses are
  surfaced from OpenAI verbatim (bounded) and are never auto-retried around.

### Threat model summary

| Threat | Mitigation |
| --- | --- |
| Compromised renderer exfiltrates tokens | Tokens never cross IPC; status-only payloads; role-gated channels; full-flow sentinel tests |
| Hidden host or future headless mode uses subscription auth | visible-ui-only sender policy + `assertInteractiveProviderAuthSender` fail closed |
| CSRF / injected callback (code OR error) on the loopback server | Non-matching `state` → 400, payload discarded, flow keeps waiting; only a state-matching callback settles |
| Local attacker cancels or completes someone else's flow over HTTP | No HTTP cancel route (IPC-only); non-matching callbacks are non-terminal |
| DNS rebinding against the loopback server | Host allow-list (`127.0.0.1:<port>` / `localhost:<port>`) → 400 otherwise; CSP `default-src 'none'`, nosniff, no-referrer on every response |
| Authorization-code interception | PKCE S256: the code is useless without the in-main verifier |
| Malicious local process squats the callback port | Typed `port_in_use` error; flow refuses to run on another port |
| Hung provider endpoint wedges a flow | AbortSignal + 30s timeout on every fetch; cancel rejects stalled calls promptly |
| Token theft at rest | safeStorage (OS keychain) encryption; `basic_text` backend refused |
| Refresh-token replay | Single-flight refresh; rotated pair persisted (or held in memory on store failure) per provider |
| Disconnect racing an in-flight refresh | Per-provider epoch: a stale-epoch refresh discards its result and persists nothing |

## MCP HTTP OAuth (BST-1468)

This is separate from provider subscription OAuth. The implementation lives in
`src/mcp/oauth-client-provider.ts` and is an SDK v2 `OAuthClientProvider` for a
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
- Tokens, client registrations, verifiers, discovery state, and resource
  identity are partitioned by configured server plus canonical resource and
  are encrypted in the dedicated `brainstrike-mcp-oauth` safeStorage store.
  `basic_text` is rejected. `disconnect` and `invalidateCredentials('all')`
  clear disk and in-memory state; unrelated provider credentials use a
  different store and are untouched.
- The provider fetch seam coalesces identical refresh-token requests and
  tags token responses with the current generation. A response from a
  generation invalidated by disconnect is not persisted. Callers must pass
  the provider fetch to the SDK transport so this authority is active.
- MCP config admits only token-free `none`, external bearer-reference, and
  `oauth-user` modes for HTTP transports. Stdio cannot select MCP HTTP OAuth,
  and an explicit auth mode cannot be combined with an `Authorization` header.

The focused fake-authorization-server suite is
`src/__tests__/main/mcp-oauth-client-provider.integration.test.ts`; the
credential boundary and config contracts are covered by the adjacent unit
tests. The remaining production integration seam is the later MCP OAuth UX
ticket: startup must report an authentication-required state and only an
explicit user action should pass the OAuth provider to a host connection.

## Development vs Production

### Development Mode
- More permissive CSP for development tools
- DevTools enabled for debugging
- Console logging for security configuration

### Production Mode
- Strict CSP without development exceptions
- DevTools disabled
- No debug logging
- Signed application bundles

## Security Checklist

- [x] Content Security Policy implemented
- [x] Context isolation enabled
- [x] Node integration disabled in renderer
- [x] Secure preload script
- [x] Navigation restrictions
- [x] Window opening restrictions
- [x] Security headers configured
- [x] Input validation in IPC handlers
- [x] Secure file system access
- [x] No hardcoded secrets
- [x] Proper error handling

## Monitoring and Updates

### Security Monitoring
- Regular dependency updates via Dependabot
- Security audit with `npm audit`
- Electron security warnings monitoring

### Update Process
- Automated security updates for dependencies
- Regular Electron version updates
- Security patch deployment process

## References

- [Electron Security Guidelines](https://www.electronjs.org/docs/tutorial/security)
- [Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [OWASP Electron Security](https://owasp.org/www-project-electron-security/)
