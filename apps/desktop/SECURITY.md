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
- Refresh: single-flight per provider, 120s proactive skew. A refresh rejected
  with `invalid_grant`/revoked marks the provider `reconnect_required`; the
  credential is kept until the user explicitly disconnects or reconnects —
  nothing is deleted silently and nothing retry-loops.

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
- Authorization requests carry PKCE S256 (RFC 7636; crypto.randomBytes with
  rejection sampling) plus a 32-byte `state`. A callback whose state does not
  match is rejected as potential CSRF and its authorization code is discarded
  without any token exchange. Callback pages are fully self-contained HTML
  (no external assets) and never echo codes or tokens.
- The RFC 8628 device flow polls with the server interval + safety margin,
  honors `slow_down`, and treats `expired_token`/`access_denied` as terminal.

### Threat model summary

| Threat | Mitigation |
| --- | --- |
| Compromised renderer exfiltrates tokens | Tokens never cross IPC; status-only payloads; role-gated channels |
| Hidden host or future headless mode uses subscription auth | visible-ui-only sender policy + `assertInteractiveProviderAuthSender` fail closed |
| CSRF / injected authorization code on the loopback callback | `state` check rejects before exchange; code discarded |
| Authorization-code interception | PKCE S256: the code is useless without the in-main verifier |
| Malicious local process squats the callback port | Typed `port_in_use` error; flow refuses to run on another port |
| Token theft at rest | safeStorage (OS keychain) encryption; `basic_text` backend refused |
| Refresh-token replay | Single-flight refresh; rotated pair persisted atomically per provider |

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