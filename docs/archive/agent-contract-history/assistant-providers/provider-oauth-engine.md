# Provider OAuth engine — evidence

Supports `docs/agents/assistant-providers.md` § "Provider OAuth engine". The descriptor contract, the status union, and the refresh rules.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2066-2129); append rather than
rewrite.

---

Desktop-main-only, provider-agnostic OAuth engine at
`apps/desktop/src/provider-auth/` (pkce / loopback-server / device-flow /
oauth-flow / refresh / descriptor-registry / provider-auth-engine). Bound by
the SIGNED legal gate `docs/OAUTH_LEGAL_REVIEW_GATE.md` — its 8 constraints
are acceptance criteria, not guidance. Do not relitigate there-settled
rulings (e.g. Anthropic subscription OAuth is PERMANENTLY REJECTED).

**Descriptor contract** (`OAuthProviderDescriptor` in
`packages/assistant-contract/src/provider-auth.ts`): providerId, clientId,
authorizeUrl, tokenUrl, `redirectPort` + `redirectPath` (loopback client
registrations pin the EXACT redirect URI — a busy port is a typed visible
`port_in_use` error naming the port, NEVER a random-port fallback; only test
fixtures may use port 0), scopes, optional `extraAuthorizeParams`, optional
`deviceFlow` (`startUrl`/`pollUrl`/`verificationUri` + optional
`responseAdapter` — the engine owns loop mechanics (interval + safety
margin, RFC 8628 slow_down backoff, deadline, cancellation) while the
adapter owns request/response SHAPE only, which is what makes opencode's
non-standard Codex flow (JSON bodies, 403/404 = keep polling, poll success
returns an authorization code + server-supplied code_verifier needing a
standard exchange) expressible with zero engine changes), and optional
`extractAccountId`. The descriptor REGISTRY
(`descriptor-registry.ts`) ships EMPTY in BST-1355; **BST-1356 ships the
first active descriptor (OpenAI Codex)**. Unknown provider = typed
`unknown_provider`, never a default.

**Status model** (`ProviderAuthStatus`, same file): `disconnected |
connecting | awaiting_browser | awaiting_device_code {userCode,
verificationUri} | connected {accountId?} | error {code} |
reconnect_required`. This union is the ONLY renderer-visible surface —
token material NEVER crosses IPC (gate constraint 3; pinned by the
no-token-over-IPC tests in
`apps/desktop/src/__tests__/provider-auth/provider-auth-ipc.test.ts` and the
fake-provider integration test). The `provider-auth` IPC domain
(start/cancel/status/disconnect) registers every channel
`{ roles: ['visible-ui'] }` via `registerAuthorizedInvoke`
(interactive-desktop-only, gate constraint 4); the preload exposes
`window.providerAuth` (`ProviderAuthBridge`), the hidden preload EXCLUDES it
(contract test), and the credential-resolution layer must call
`assertInteractiveProviderAuthSender` before resolving an OAuth credential.

**Refresh** (`refresh.ts`): single-flight per provider (concurrent callers
collapse onto one network call — rotating refresh tokens are never
replayed), proactive refresh inside a 120s expiry skew, persisted rotation
(server-omitted refresh_token keeps the old one per RFC 6749 §6), and every
engine fetch (exchange, device start/poll, refresh) runs under the flow's
AbortSignal + a 30s per-request timeout (`fetch-guards.ts`).
`invalid_grant`/revoked = typed `reconnect_required` result + status; the
stored credential is KEPT (never deleted silently; the user disconnects or
reconnects explicitly), and nothing ever retry-loops.
Rotation-then-persist-failure holds the rotated pair IN MEMORY as the active
credential (session keeps working; status `credential_persist_failed`; a
later successful persist clears it; restart lands in `reconnect_required`).
Disconnect bumps a per-provider epoch so an in-flight refresh completing
afterwards discards its result and persists nothing. A successful exchange
that returns no refresh_token is the distinct `refresh_token_missing` code
(scope problem, not a transient failure). Engine-written credentials are
`{ type: 'oauth', access, refresh, expires, accountId? }` in the BST-1348
secrets store, so factory reset already wipes them (guarded in
`apps/desktop/src/__tests__/secrets.test.ts`).

Threat model + loopback hygiene live in `apps/desktop/SECURITY.md`
("Provider OAuth subscription auth" section). When changing the engine,
update BOTH docs and the paired tests under
`apps/desktop/src/__tests__/provider-auth/`.
