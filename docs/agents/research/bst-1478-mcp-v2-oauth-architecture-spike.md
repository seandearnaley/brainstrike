# MCP 2026-07-28, TypeScript SDK v2, and remote OAuth architecture spike

Date: 2026-08-28

Status: historical research evidence; decisions promoted to the
[living provider contract](../assistant-providers.md#mcp-2026-host-architecture)

This document preserves the source analysis and rejected alternatives from the
spike date. It is not the authority for current implementation behavior; the
living provider contract above is.

Scope: Brainstrike desktop as an MCP host/client. Linear is the motivating
compatibility case, not a provider-specific design.

Sources are limited to the current MCP specification/docs, the official TypeScript
SDK repository/release/migration guides, OAuth RFCs referenced by MCP, and Linear's
official MCP docs. Release-specific claims are grounded in the exact
`@modelcontextprotocol/server@2.0.0` tag: annotated tag object `a661655` peels to
[`cc4b416`](https://github.com/modelcontextprotocol/typescript-sdk/tree/cc4b41617ce3601b1290d67216ea0b194a3cd9ac).
Later `main` behavior is not assumed by the 2.0.0 harness or production design;
post-release fixes require an explicit dependency update and their own regression
proof before adoption.

## Executive conclusion

Do not solve Linear OAuth by increasing Brainstrike's stdio timeout or permanently
wrapping remote servers with `mcp-remote`. Build one desktop-main-owned MCP host service
using `@modelcontextprotocol/client@2.0.0`, the SDK's `OAuthClientProvider`, and a
dedicated encrypted MCP credential store. OAuth remains outside the renderer; the UI
receives token-free states and explicit Authenticate/Reauthorize/Disconnect actions.

“MCP v2” has two different meanings that must not be conflated:

- MCP itself is date-versioned. The current stable wire revision is
  **`2026-07-28`**, a new stateless era with per-request metadata,
  `server/discover`, MRTR, and `subscriptions/listen`.
  [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- The TypeScript SDK is semver-versioned. Its current stable client is
  **`@modelcontextprotocol/client@2.0.0`**, released 2026-07-27. It replaces the
  monolithic v1 package and supports both modern and legacy protocol eras.
  [SDK release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fclient%402.0.0),
  [protocol-era guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/protocol-versions.md)

Brainstrike directly depends on `@modelcontextprotocol/sdk@1.30.0`; transitive v2
`core`/`server` packages in the lockfile do not make its client v2.
[catalog](../../../pnpm-workspace.yaml#L52),
[agent package](../../../packages/agent/package.json#L23),
[desktop package](../../../apps/desktop/package.json#L89)

Linear's native endpoint is Streamable HTTP. Its interactive flow uses OAuth 2.1 with
Dynamic Client Registration (DCR); read-only access is available through
`/mcp/readonly` or OAuth scope `read`; direct bearer tokens are also supported; SSE is
deprecated. First-class MCP OAuth therefore solves the observed Linear failure without
a proxy. [Linear MCP docs](https://linear.app/docs/mcp)

## Terminology and version matrix

| Term | Canonical meaning | Brainstrike action |
| --- | --- | --- |
| Protocol revision | Date such as `2025-11-25` or current `2026-07-28`. [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) | Store/display the negotiated revision and era per server. |
| Legacy era | Revisions through `2025-11-25`; uses `initialize`, and legacy Streamable HTTP may use sessions/GET. [SDK era guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/protocol-versions.md) | Retain interoperability through SDK v2. |
| Modern era | `2026-07-28`; no `initialize` or protocol session; every request carries version/capabilities; change events use `subscriptions/listen`. [transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) | Explicitly select SDK `versionNegotiation: { mode: 'auto' }`; v2 defaults to legacy. [adoption guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/migration/support-2026-07-28.md) |
| SDK v1 | Monolithic `@modelcontextprotocol/sdk`; Brainstrike pins 1.30.0. | Migrate the complete connection owner, not objects piecemeal. |
| SDK v2 | Split `@modelcontextprotocol/client`, `/server`, and `/core`; Node 20+, ESM-first plus CJS. [migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/migration/upgrade-to-v2.md) | Production needs `/client`; test servers need `/server`; raw Zod schemas, if used, need `/core`. |
| Extension | Optional, independently versioned capability under a prefixed identifier; disabled by default and not required for core conformance. [extensions](https://modelcontextprotocol.io/extensions/overview) | Advertise only installed, complete adapters. |

Important SDK breaks for Brainstrike: imports move to the split packages and stdio to
`@modelcontextprotocol/client/stdio`; spec `callTool()`/`request()` drop their explicit
result-schema argument; low-level handlers use method strings; `McpError` becomes
wire-facing `ProtocolError`, local failures use `SdkError`, HTTP failures use
`SdkHttpError.status`, and `StreamableHTTPError` is removed. Zod `*Schema` constants
move to `/core`. v1/v2 class instances must not cross a staged boundary.
[SDK migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/migration/upgrade-to-v2.md)

## Complete client support: exact scope

Core conformance does not require every optional extension or deprecated feature. A
truthful Brainstrike claim means: both eras interoperate; every active server capability
has an end-to-end host path; every advertised client capability/extension is fully
implemented; deprecated compatibility is listed separately.

| Surface | Verified requirement | Brainstrike policy |
| --- | --- | --- |
| Discovery/versioning | `server/discover` returns supported versions, capabilities, identity, instructions, and cache hints. [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) | Use `auto`; show exact era/capabilities; initially do not persist legacy verdicts because stale verdicts silently miss server upgrades. |
| Transports | Modern Streamable HTTP uses independent POSTs, JSON or request-scoped SSE responses, required `Mcp-*` headers, `x-mcp-header`, stream-close cancellation, and no session/GET/resume. [transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) stdio uses child stdin/stdout with diagnostics on stderr. [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) | Keep explicit `stdio`/`streamable-http`/deprecated `sse`; never silently switch transports. Let SDK v2 own wire behavior. |
| Tools | List/call, pagination, list changes, title/icons, input/output JSON Schema, annotations, `_meta`, structured content, text/image/audio/resource links/embedded resources, and `isError` semantics. [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | Preserve the whole envelope until policy/projection; annotations are untrusted. |
| Resources/templates | List/read text or blob resources, templates, metadata, annotations, updates, and subscriptions. [resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources) | Add resource browser and bounded agent list/read verbs; never auto-inject arbitrary resources. |
| Prompts/completion | List/get prompts and complete prompt/resource-template arguments. [prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts), [completion](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/completion) | Prompts are user-selected templates with visible provenance, not silent system instructions. |
| Subscriptions/cache | Modern change notifications use one filtered `subscriptions/listen` stream; SDK does not auto-relisten after remote drop. Cacheable results carry `ttlMs`/`cacheScope`; private cache entries cannot cross auth contexts. [SDK subscriptions](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/clients/subscriptions.md), [SDK caching](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/clients/caching.md) | One connection-owned watcher; bounded reconnect; per-principal cache partition. |
| Progress/cancellation | Progress tokens are unique per active request; progress stops at completion. Streamable HTTP cancels by closing the response stream; stdio sends cancellation; a maximum timeout remains even when progress resets idle timeout. [progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress), [cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation) | Extend existing progress/AbortSignal wiring to all requests; add explicit total deadlines and race tests. |
| Elicitation/MRTR | Form and URL elicitation require accept/decline/cancel and clear server provenance; secrets must use URL mode. Modern servers return `input_required` on tool/resource/prompt requests; clients preserve opaque `requestState`, fulfill declared inputs, and retry with a new ID. [elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation), [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) | Implement through Brainstrike suspension/resume with SDK `maxRounds: 10`; never parse or reuse request state. |
| Roots/sampling/logging | All are deprecated in `2026-07-28`; new implementations should not adopt them. [deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) | Do not advertise. Add compatibility handlers only for a demonstrated legacy need. Protocol logging is distinct from required transport/child diagnostics. |
| Tasks extension | `io.modelcontextprotocol/tasks` adds durable task handles, polling, `tasks/get/update/cancel`, mid-flight input, and optional notifications. [Tasks](https://modelcontextprotocol.io/extensions/tasks/overview) | Separate adapter after MRTR/subscriptions; persist task IDs. SDK core method maps deliberately exclude the new extension, so use exact extension schemas/custom methods. [SDK guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/migration/support-2026-07-28.md#tasks-deprecated-wire-vocabulary) |
| MCP Apps extension | `io.modelcontextprotocol/ui` requires `ui://` resources, sandboxed iframe rendering, CSP/permissions, and a validated postMessage RPC dialect. [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) | Remove current false advertisement; re-enable only after the complete host/security surface exists. |
| Auth extensions | Official catalog also defines OAuth Client Credentials and Enterprise-Managed Authorization. [extensions](https://modelcontextprotocol.io/extensions/overview) | Model as separate explicit auth modes; do not conflate with user OAuth. |

Skills over MCP is mentioned on the specification landing page but is absent from the
stable official extension catalog. Treat it as experimental, not part of the completion
gate. [spec](https://modelcontextprotocol.io/specification/2026-07-28),
[extension catalog](https://modelcontextprotocol.io/extensions/overview)

## Current Brainstrike gap map

| Area | Evidence | Gap |
| --- | --- | --- |
| SDK/protocol | Direct v1.30 dependency and v1 imports. [HTTP client](../../../packages/agent/src/mcp/explicit-http-client.ts#L1-L6), [stdio client](../../../packages/agent/src/mcp/explicit-stdio-client.ts#L1-L2) | No SDK v2 or modern era. |
| Config/auth | Schema supports transport, URL/process fields, headers/env, and enabled tools only. [config](../../../packages/agent/src/mcp/config.ts#L3-L37) Desktop examples place bearer auth in headers. [template](../../../apps/desktop/src/mcp-loader.ts#L148-L180) | No OAuth/auth-mode contract or token-free secret reference. |
| Client surface | Runtime and desktop contracts expose only list/call tools and close. [runtime](../../../packages/agent/src/mastra/mcp-runtime-client.ts#L32-L45), [desktop](../../../apps/desktop/src/mcp/types.ts#L3-L23) | No resources, prompts, completion, discovery metadata, subscriptions, elicitation, tasks, or auth state. |
| Ownership | Settings maintains a desktop client map while assistant runs construct another set. [desktop owner](../../../apps/desktop/src/mcp/index.ts#L6-L36), [runtime owner](../../../packages/agent/src/mastra/mcp-runtime-client.ts#L62-L108) | Duplicate child/HTTP/auth/refresh/subscription lifecycles; unsafe for rotating refresh tokens. |
| OAuth timeout | Desktop stdio connect has a 10-second default deadline, overridable only through `MCP_STDIO_CONNECT_TIMEOUT_MS`. [stdio](../../../apps/desktop/src/mcp/stdio-client.ts#L7-L24) | Human authorization is incorrectly coupled to child connection when using a proxy. |
| Capability honesty | HTTP and stdio clients always advertise `io.modelcontextprotocol/ui: {}`. [HTTP](../../../packages/agent/src/mcp/explicit-http-client.ts#L336-L341), [stdio](../../../packages/agent/src/mcp/explicit-stdio-client.ts#L218-L223) | False MCP Apps claim; no resource reader/sandbox/postMessage host. |
| Existing foundation | Provider OAuth already has main-process ownership, token-free statuses/IPC, loopback/browser patterns, refresh single-flight, and encrypted storage. [contract](../../../packages/assistant-contract/src/provider-auth.ts#L1-L46) | Reuse security/UI primitives, not its fixed endpoint descriptor or narrow credential shape; MCP SDK must own MCP OAuth algorithms. |
| UI/diagnostics | MCP status is connected/disconnected/error plus tool count. [settings](../../../packages/settings-ui/src/settings/tools/types.ts#L84-L92) | No auth-required/reconnect/scope/era/capability states; child stderr and protocol phases are not durable status. |

## Recommended architecture

`McpHostService` is a desktop-main singleton and the only SDK client owner. A per-server
actor owns one `Client`, transport, auth provider, capability snapshot, cache,
subscriptions, requests, and teardown. Settings and the assistant runtime receive a
structural `McpHostPort`; they never construct clients. Config replacement publishes a
new generation, cancels the old one, and ignores stale late events.

Remote config gains a strict auth union: `none`, `oauth-user`, `bearer` (secure-store
reference), `oauth-client-credentials`, and future extension adapters. `headers` remains
for non-auth headers. Existing `headers.Authorization` remains an explicit legacy
spelling when `auth` is absent and gets a visible migration warning; supplying both is
an error. Tokens, codes, verifiers, client registrations, and secrets never enter config,
IPC, URLs, or logs.

### OAuth lifecycle

MCP OAuth applies to HTTP; stdio should receive credentials through its environment.
The SDK must own Protected Resource Metadata and authorization-server discovery,
registration, PKCE, RFC 8707 resource indicators, issuer validation, refresh, and scope
step-up. Brainstrike implements only the SDK provider's storage/browser boundary.
[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/index)

1. Background discovery with no token becomes `authentication_required`; startup must
   not unexpectedly open a browser.
2. Explicit Authenticate starts SDK discovery/registration. Prefer pre-registration or
   Client ID Metadata Documents; retain DCR for Linear compatibility although DCR is
   deprecated. [client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
3. Main opens the validated authorization URL externally and receives one fixed
   loopback callback. Brainstrike validates `state`; the SDK explicitly does not.
4. Pass complete callback `URLSearchParams` to `finishAuth()` so SDK validates RFC 9207
   `iss`, then reconnect using a fresh transport.
   [SDK OAuth guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/clients/oauth.md)
5. Persist SDK tokens/client information verbatim by canonical resource URL + issuer,
   plus discovery state, verifier/state, and most-recent issuer. Refresh tokens require
   OS-backed encrypted storage. [SDK conformance obligations](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/migration/upgrade-to-v2.md#conformance-obligations-for-oauthclientprovider-implementers)
6. Configure insufficient scope to suspend and show consent rather than opening a
   surprise browser from a background tool call. Resume only after reauthorization.

Durable diagnostics record token-free lifecycle phase, transport/era, SDK error code,
HTTP status, request duration/cancel/progress/MRTR round, subscription close reason,
and bounded stdio stderr. Never log auth headers, bodies, tokens, codes, verifiers, or
callback error text after issuer mismatch.

## Verification architecture

Verification is a first delivery dependency, not a P7 cleanup activity. The shared
harness is tracked by Linear issue `BST-1475` and gives later implementation tickets
the same public seams, fixtures, scenario identifiers, artifact schema, and teardown
guarantees. It is production-independent infrastructure: production SDK migration,
Electron OAuth, live Linear interoperability, and official conformance remain the
acceptance criteria of `BST-1463`, `BST-1469`, and `BST-1472`, respectively. They may
consume this lab, but they cannot be pulled into the harness PRs.

The reusable Node-only lab lives in `packages/mcp-test-lab` as
`@brainstrike/mcp-test-lab`, separate from Playwright-specific app helpers and absent
from every production dependency graph. The modern reference is a bounded,
source-backed profile of the exact-pinned official SDK v2
`test/conformance/src/everythingServer.ts`; it preserves representative official
tool/resource/prompt/completion names and behavior while remaining deterministic.
It is not the full upstream process-global server and is not an official-conformance
claim. The legacy, OAuth, and stdio fixtures remain Brainstrike-owned. The official conformance runner remains the authoritative
conformance target, and Brainstrike production proof must dispatch through the real host
interface rather than an SDK-to-SDK self-test.

The only pre-agreed test seams are:

1. strict MCP configuration plus typed desktop-main server status;
2. the desktop-main MCP host port for connection, discovery, calls, active core
   primitives, client input, cancellation/progress, and close/reset;
3. token-free preload/Settings IPC state and explicit user actions; and
4. the actual Electron main/preload/renderer stack launched with
   `pnpm --filter @brainstrike/desktop dev:agent-debug` and an isolated profile.

Each vertical slice starts with one behavior-level failure at the narrowest seam,
records why it is red, implements only enough to turn it green, and adds a failure
path before closing. Protocol and lifecycle assertions use real SDK exchanges;
mocks stop at OS, browser, clock, and credential-store boundaries. Intentional fault
switches or mutation canaries prove that each harness layer can become red.

The deterministic MCP lab starts with that source-backed official modern profile
on the exact-pinned SDK v2 for `2026-07-28`, a legacy server, lab-owned real stdio, and a
loopback OAuth protected-resource/authorization server. The initial executable
OAuth surface is protected-resource and authorization-server metadata, DCR,
S256 PKCE, issuer/resource binding, authorization-code exchange, and bearer
protection. Refresh/revocation, scope step-up, callback and port failures,
pagination, subscription loss, progress/cancellation races, and MRTR remain
explicit implementation-ticket scenarios; the manifest must not advertise them
as executable before their faults and assertions exist. Fixtures use ephemeral
loopback ports, no ambient credentials, correlation IDs, and bounded runners
shared by local tests and CI.

Evidence is layered:

- fast unit/contract tests for policy, validation, state, storage, redaction, and reset;
- real HTTP/stdio integration through production adapters;
- exact-pinned official legacy and 2026 conformance suites;
- Electron E2E through real preload/IPC and desktop-main ownership; and
- manual actual-app sessions through Computer Use or a Luna subagent connected to CDT
  for user-visible, OAuth, lifecycle, and security-sensitive behavior.

The production closeout has two independent live targets: `BST-1469` proves direct
Linear OAuth without `mcp-remote`, including an explicitly approved disposable write;
`BST-1463` proves the production host negotiates `2026-07-28` with the exact-pinned
official modern SDK server. Linear's negotiated era is observed rather than assumed.
Manual evidence includes screenshots where useful, renderer console, relevant network
metadata, durable main logs, sanitized child stderr, and
process/listener/credential cleanup. All artifacts are secret-scanned before
attachment. These are downstream production gates, not `BST-1475` completion criteria.

No ticket is Done and no PR is READY until its required scenarios are green at the
exact head and the evidence bundle records the SHA, dirty state, exact versions,
commands/statuses/counts, focused red then green proof, negotiated capabilities,
correlation IDs, manual checklist where applicable, and known gaps linked to Linear.
CI verifies this bounded local evidence; it is not the first test runner.

## Host interface decision

Four independent interface designs were compared for depth, locality, and caller
authority. The settled external seam is one Electron-main `McpHost` with five lifecycle
operations: synchronous `snapshot`, typed `invoke`, filtered `watch`, ordered
`replaceConfig`, and terminal `close`. Protocol breadth lives in a closed typed operation
table; there is no method per SDK verb and no raw `request(method, params)` escape hatch.

Assistant and renderer integrations are least-authority adapters over that same host,
not separate owners. Assistant adapters can discover and invoke but cannot mutate auth or
configuration. Renderer IPC receives token-free snapshots and explicit Settings actions,
never the host or SDK values. Tool, server, invocation, continuation, task, and Apps
identifiers are opaque; callers never parse display names to route operations.

The SDK-first stack order remains intentional. Defining the operation DTOs from the
pinned v2 packages once avoids introducing a temporary v1-shaped host seam that would be
deleted immediately. The verification-lab branch supplies the first failing production
tracer, and the SDK/era branch makes that tracer green before the connection-authority
implementation expands to OAuth and the rest of the protocol.

For stdio `auto` negotiation, the host invariant is one logical actor and at most one
steady-state child. The SDK may create a bounded disposable probe child to determine the
era; every probe is observed and reaped, and `close` proves zero remaining children.

## Phased ticket matrix

| Phase / ticket | Dependencies | Deliverable | Acceptance criteria |
| --- | --- | --- | --- |
| PV Verification harness (`BST-1475`) | None | Production-independent scenario manifest, source-backed official modern profile, legacy/OAuth/stdio reference fixtures, fault injection, evidence schema, bounded runner, and Electron/CDT recipe. | Every exported verifier behavior has focused red/green proof; fixtures and runner are bounded and clean up all owned resources; no production SDK, Electron OAuth, live Linear, full upstream-server, or official-conformance claim is included. |
| P0 Truthful baseline | PV | Capability contract tests; remove unconditional MCP Apps advertisement; document exact versions/deprecations. | No unimplemented capability is advertised; existing tool-only fixtures remain green. |
| P1 SDK v2 + single owner | P0 | Split v2 packages, `McpHostService`, `auto` era negotiation, finite pagination/MRTR/timeouts, explicit transports. | Real stdio and HTTP fixtures pass legacy `2025-11-25` and modern `2026-07-28`; exactly one client/child per server generation; modern wire has no session/GET behavior. |
| P2 OAuth + Linear | P1; encrypted MCP auth store/reset hook | Strict auth config, SDK `OAuthClientProvider`, token-free IPC/UI, reauth/scope suspension, Linear live proof. | Native Linear browser flow works without proxy; restart reuses/refreshes credentials; disconnect/reset clears disk and memory; state/issuer/port/DCR/storage/401/403 failures are distinct and tested; zero secret leakage. |
| P3 Active core primitives | P1; P2 for auth fixtures | Complete tools, resources/templates, prompts, completion, discovery metadata, subscriptions, cache. | Every advertised server capability has UI/runtime path; pagination/cache/invalidation/drop/reconnect and malformed `x-mcp-header` have real-protocol tests. |
| P4 Elicitation + MRTR | P3; assistant suspension/persistence | Form/URL elicitation and exact tool/resource/prompt retry lifecycle. | Review/decline/cancel work; secrets cannot use form mode; opaque state is echoed unchanged; fresh IDs and exactly-once resume survive cancel/restart races. |
| P5 Tasks extension | P3–P4; durable task store | Exact Tasks adapter, polling, update/input, cancellation, notifications, restart. | Both sides must advertise; task IDs resume after restart; polling stops terminally; current official Tasks scenarios pass. |
| P6 MCP Apps, if approved | P3; security review | `ui://` fetch, sandbox/CSP/permissions, postMessage schema/origin checks, normal tool permission routing. | Capability remains absent until complete; adversarial sandbox and official interoperability tests pass. |
| P7 Conformance/release gate | All claimed phases | Exact-pin official conformance runner, desktop E2E, packaged/restart/reset tests, published support matrix. | Zero unexpected or stale expected failures; root quality gate green; release claims name protocol revisions, transports, core features, deprecations, and exact extension IDs. |

The official TypeScript SDK pins and deliberately reconciles
`@modelcontextprotocol/conformance`; Brainstrike should follow that practice but must
also test its own IPC/auth/UI/persistence adapters, which SDK conformance cannot cover.
[SDK conformance harness](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/test/conformance/README.md)

## Risks and open questions

1. **CIMD hosting:** preferred registration requires a stable organization-controlled
   HTTPS client metadata document. Until then, use pre-registration/DCR where supported.
2. **Credential schema:** existing provider credentials omit issuer-stamped SDK tokens,
   registration and discovery state; use a dedicated MCP store with the same encryption
   and factory-reset guarantees.
3. **Headless runs:** an already-valid token may be used, but browser auth, elicitation,
   and scope consent require visible user attention. Unobserved runs must suspend or fail
   visibly, never launch UI.
4. **Catalog size/trust:** complete resources/prompts support does not mean injecting all
   content into model context. Use bounded discovery/read operations and visible server
   provenance.
5. **Extensions:** SDK v2 core intentionally does not make Tasks a typed core method.
   Pin extension schemas and conformance separately; never cast around the boundary.
6. **Deprecated compatibility:** adopting SDK v2 does not itself authorize removing SSE
   or legacy-era support. Use explicit telemetry and a separate product decision.

## Canonical completion statement

After P0–P4 and P7, Brainstrike may say it uses TypeScript MCP SDK v2 and supports MCP
`2026-07-28` plus legacy-era interoperability over explicitly selected stdio and
Streamable HTTP, with first-class remote OAuth and all active core server primitives.
Tasks, MCP Apps, deprecated features, and auth extensions must be listed separately.
Never state “complete MCP v2 support” without that matrix.

## Primary source inventory

- [MCP `2026-07-28` specification](https://modelcontextprotocol.io/specification/2026-07-28),
  [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
  [schema](https://modelcontextprotocol.io/specification/2026-07-28/schema),
  [deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/index),
  [discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery),
  [registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration),
  [security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [SDK v2 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fclient%402.0.0),
  [v1→v2 guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/migration/upgrade-to-v2.md),
  [2026 adoption guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/migration/support-2026-07-28.md),
  [client OAuth](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/clients/oauth.md)
- [Extensions](https://modelcontextprotocol.io/extensions/overview),
  [Tasks](https://modelcontextprotocol.io/extensions/tasks/overview),
  [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
- OAuth standards incorporated by MCP:
  [OAuth 2.1 draft 13](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13),
  [RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750),
  [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591),
  [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414),
  [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707),
  [RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207),
  [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)
- [Linear MCP documentation](https://linear.app/docs/mcp)
