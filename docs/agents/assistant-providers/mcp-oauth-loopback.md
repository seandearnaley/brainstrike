# MCP OAuth provider and stable loopback port — evidence

Supports `docs/agents/assistant-providers.md` § "MCP 2026 host architecture". The main-process provider seam, the persisted loopback port, and the reauthorization latch.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 3838-3925); append rather than
rewrite.

---

BST-1468 supplies the main-process provider seam in
`apps/desktop/src/mcp/oauth-client-provider.ts`. It deliberately delegates
the protocol algorithms to the installed `@modelcontextprotocol/client@2.0.0`
implementation: RFC 9728/RFC 8414/OIDC discovery, RFC 9207 issuer checks,
CIMD/pre-registration/DCR selection, PKCE, RFC 8707 resource binding, refresh,
one 401 retry, and 403 insufficient-scope step-up. The provider supplies an
stable `127.0.0.1` callback listener, the validated external-browser handoff,
encrypted state persistence, and a generation-tagged refresh fetch seam. The
provider fetch must be passed to the SDK transport for refresh coalescing and
disconnect fencing to apply. The later UX ticket owns the explicit
Authenticate/Reauthorize action and the startup `authentication_required`
projection; no background connection may open a browser implicitly.

**Stable loopback port (BST-1597, do not relitigate).** The dynamic client
registration records `redirect_uris: [http://127.0.0.1:<port>/mcp/oauth/callback]`,
and `persistedClientSupportsRedirect` compares that URI by exact href. An
ephemeral port therefore invalidated the registration on **every** relaunch, for
**every** DCR server, which then burned the authorization allowance and reported
`mcp-connection-failed` beside stored credentials. The bound port is persisted
per store identity (configured server + canonical resource + requested scope
set) as `loopbackPort` on that identity's records, and the next launch rebinds
it before the provider is constructed — so `loadOAuthStartupState` reads the
store BEFORE it listens, never concurrently. Per-identity rather than one
app-wide port because several OAuth servers can be connected at once and each
needs its own live listener; the port lives with the registration it belongs to,
inside the same encrypted store, so disconnect and factory reset already clear
it and no new persistence surface exists. The loopback comparison is
deliberately NOT relaxed for a differing port: RFC 8252 §7.3 is a SHOULD on the
authorization server, and trading a deterministic re-registration for an
`invalid_redirect_uri` the code cannot recover from would be a silent
degradation. A port another process now owns falls back to a fresh one, reports
`reportUnavailableLoopbackPort`, and accepts that a re-registration follows.
The bind-time `'error'` rejector is removed once the listener binds, so a
permanent replacement handler takes its place: a bound `http.Server` with no
`'error'` listener turns a later accept-path fault (EMFILE/ENFILE) into an
unhandled `'error'` event, which in Electron main is a process crash rather than
a failed OAuth callback. The fault is reported through
`reportLoopbackListenerFault`, never absorbed silently and never rethrown.

Discarding a registration means the stored grant is unusable, so the provider
raises `requiresReauthorization()` and `closeAfterConnectFailure` reclassifies
the connect fault as `mcp-authentication-required` — the actor's
`authentication-required` state with a Connect affordance — instead of a
terminal connection failure. That rewrite is deliberately narrow: ONLY the
generic `mcp-connection-failed` fallback is rewritten, because
`mcp-browser-open-failed`, `mcp-auth-callback-timeout`, `mcp-server-rejected`,
`mcp-protocol-timeout` and `mcp-child-exited` already name an actionable fault
and a second Connect button in their place hides the only thing the user can act
on. The latch itself is deliberately NOT cleared when `saveClientInformation`
writes the replacement registration: a registration whose authorization never
completed still leaves the stored grant unusable, which is exactly the relaunch
case the integration proof pins. It cannot strand a later unrelated fault
either, because the provider is constructed inside the per-attempt client
factory and closed with the attempt that failed — the next connect builds a
fresh provider that re-reads the store, finds a redirect-compatible
registration, and never raises the latch at all. Both reasons are logged, never
absorbed. Every provider start logs
`MCP OAuth loopback callback listener bound` with its port and
`reusedPersistedPort`; the packaged relaunch proof in
`apps/desktop/e2e/mcp-packaged-core.desktop.test.ts` asserts the restarted
launch rebinds the same port in the records IT appended, reconnects, and emits
no `Discarding stale MCP OAuth dynamic client registration` record.

The `2026-07-28` authorization-server migration contract requires a challenged
bearer request to rediscover protected-resource metadata before selecting the next
authorization server. A context-free token read marks that issuer's discovery stale;
reads and unrelated saves neither consume nor clear it. Only successful replacement
token persistence for that issuer clears the mark (close/reset clears all), forcing
fresh PRM while remaining bounded by persisted issuer records. Callback-leg discovery
remains available for RFC 9207 `iss` validation. Client information, tokens, and discovery
remain issuer-partitioned, so migration re-registers instead of replaying credentials.

Deterministic production-provider coverage lives in
`apps/desktop/src/__tests__/main/mcp-oauth-client-provider.integration.test.ts`.
It observes resource mismatch before DCR/authorization, `offline_access` inclusion
only when AS metadata supports it, the required RFC 9207 response matrix,
metadata-issuer rejection before endpoint use, and a real two-AS migration with
replacement registration and no original-AS credential reuse. The alpha.10
closeout remains the final 11/11 fixture proof; an always-connected host mock is
not security evidence.

Canonical basis: the [MCP 2026-07-28 authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
requires strict authorization-response issuer validation and issuer-bound client
credentials; RFC 9207 requires validation before code redemption; RFC 8707 and RFC
9728 define resource binding and protected-resource metadata. The installed
alpha.10 package resolves to npm `gitHead`
`a9896553900a2ef61787b57adfcbbe936a8ab1f9`; its CLI is the applicability authority,
not later upstream `main`.
