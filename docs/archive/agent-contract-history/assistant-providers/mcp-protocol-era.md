# MCP protocol era negotiation — evidence

Supports `docs/agents/assistant-providers.md` § "MCP TRANSPORT SELECTION (CRITICAL)". Transport and protocol discriminators, the negotiated-fact getters, and shared normalization.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2359-2404); append rather than
rewrite.

---

Every MCP server chooses its transport explicitly. The authoritative config
discriminator is one of `stdio`, `streamable-http`, or legacy `sse`; it is never
omitted, inferred from a URL path, or changed after a failed connection.

Protocol policy is a separate discriminator: `legacy`, `auto`, or the pinned
`2026-07-28`. Existing entries that omit it normalize to `legacy` without
rewriting their JSONC; the loader emits a durable warning and a structured
`mcp_protocol_defaulted_to_legacy` migration record. Explicit policy is never
inferred from URL, transport failure, status code, or server behavior. Legacy
SSE accepts only `legacy`.

The production HTTP and stdio clients expose the official SDK's negotiated
facts through `getProtocolEra`, `getNegotiatedProtocolVersion`,
`getServerVersion`, and `getServerCapabilities`. Those getters return
`undefined` before connection and after close; modern server identity may also
be absent because it is optional discovery metadata. `auto` probes
`server/discover`, pinned modern never initializes a legacy server, and HTTP
401/403 retain their transport error code and status, 5xx becomes
`EraNegotiationFailed` with its status preserved, and silence becomes
`RequestTimeout`; none become legacy evidence. For stdio, `auto` pays for a
disposable probe child plus the session child on each connection, so servers
with expensive or non-idempotent startup should use an explicit policy. These
getters—not exported latest-version constants—are the authority for the actual
negotiated revision.

Both transports compose client-handler capabilities and `inputRequired`
through one shared normalizer. The absent configuration is deliberately safe:
no client capabilities are advertised, while modern input-required handling is
bounded to `{ autoFulfill: true, maxRounds: 8 }`. An explicit
`inputRequired.autoFulfill: false` preserves the SDK's per-call
`allowInputRequired` manual mode; only duplicated round-cap fields are
ambiguous and rejected with a field-specific error. On reconnect, the first
cursorless tools, resources, resource-templates, and prompts list each bypasses
an otherwise-fresh response-cache entry independently. HTTP roots-change
notifications use the same session-recovery path as requests and check caller
cancellation before each send attempt; completion is not retroactively changed
by an abort that occurs after the notification was sent.

The capability engine currently installs handlers onto a newly constructed SDK
`Client` and returns no handler lease; connection close therefore owns their
lifetime today. Before a host may replace advertised capabilities on a live
client, the engine must make `install` return an idempotent release lease and
each transport must release that lease on invalidation, failed connect, and
terminal close. Production capability advertisement remains disabled until
that ownership hook exists.

