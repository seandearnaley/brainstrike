# MCP config and client ownership flow — evidence

Supports `docs/agents/assistant-providers.md` § "Production Apps host". The five ownership layers from config grammar to the agent runtime client.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 3316-3395); append rather than
rewrite.

---


Ownership and flow:
1. Config — `packages/assistant-contract/src/mcp-config.ts` owns the shared
   transport grammar, normalization, migration records, and machine-readable
   `invalid_mcp_config` diagnostics at the explicit `mcp-config` package
   subpath. Consumers add capability-scoped wrappers: Agent rejects bearer
   references because it has no production credential resolver, while Desktop
   accepts them and resolves credentials in its owning host. Agent JSON and
   Desktop JSONC ingestion both use the shared grammar; Desktop additionally
   retains syntax/location, duplicate-key, and established user-facing prose
   diagnostics and revalidates decrypted records. Unknown fields, malformed
   spawn/HTTP values, and unsupported policy combinations fail visibly.
   `{ servers: [] }` is accepted
   as an explicit request for no configured servers; it does not synthesize a
   server, and Agent without a host returns no runtime client. Public renderer
   status exposes server name, transport, effective protocol policy, and
   token-free migration records.
2. Official clients — `packages/agent/src/mcp/explicit-stdio-client.ts` and
   `explicit-http-client.ts`, exported only from
   `@brainstrike/agent/mcp-client`, own the stable SDK v2 split-package transports,
   lazy/concurrency-safe connection, request forwarding, and idempotent close.
   The HTTP client additionally owns header composition and Streamable HTTP
   session termination. Core resource/template/prompt/completion operations and
   modern `subscriptions/listen` remain on the same request/recovery seam as
   tools. The first cursorless tools/resources/templates/prompts list on every
   new HTTP or stdio connection forces the SDK cache to refresh; subsequent
   requests use the caller/SDK cache policy. Feature-event subscribers settle
   independently with `Promise.allSettled`, and each rejection reaches the
   explicit diagnostic sink even when another subscriber or the sink itself
   rejects. SDK client close remains the sole subscription/listener teardown
   owner. This transport support does not update the product support matrix;
   the desktop authority layer must integrate and verify it first.
   `client-extension-registry.ts` is the typed host-owned
   capability boundary; it does not implement an extension itself. Only
   non-empty MCP config loads the dedicated subpath; keep split SDK packages out
   of root/browser-safe/Hosted Web bundles (the emitted-bundle verifier enforces
   this). Cross-package Desktop integration tests use only the explicit
   `@brainstrike/agent/test-fixtures/mcp-host-lifecycle` and spawned-fixture
   exports. They never traverse Agent's private `src/__tests__` tree, and the
   fixture entrypoints remain unreachable from production Agent entrypoints.
3. Desktop host composition — `apps/desktop/src/mcp/host-runtime.ts` constructs
   the shared explicit clients only behind `McpHostService` actors. The dormant
   pre-host global client registry, desktop `McpClient` wrapper, and HTTP/stdio/SSE
   factory adapters do not exist. Shared token-free status projection and
   discovered-tool types remain in `apps/desktop/src/mcp/types.ts`; removing the
   obsolete wrappers must not remove those helpers or any protocol-era behavior
   owned by the active explicit clients.
4. Desktop authority — startup configuration and tool discovery flow through the
   singleton `DesktopMcpHostRuntime`; malformed reloads preserve the last valid
   authority, absent config installs explicit empty authority, and stale
   discovery epochs cannot overwrite a newer config projection. File-watcher
   projections are serialized, stale loads are discarded, and reload failures
   remain distinct from projection callback failures. Shutdown closes the active
   host and aggregates its close report; factory reset replaces its resolved
   configuration with explicit empty authority. Neither path invokes a parallel
   legacy registry cleanup owner.
5. Agent runtime — `packages/agent/src/mastra/mcp-runtime-client.ts` adapts the
   injected desktop host authority; it never constructs or closes an SDK client.
   Each run owns only generation-fenced watchers and cancellation leases, rolls
   them all back on partial construction failure, and applies the host snapshot's
   enabled-tool policy before converting discovered tools through the shared
   Mastra adapter. Progress and caller cancellation forward through the host.
   This preserves the
   complete `CallToolResult` until the adapter deliberately selects
   structured-only output or retains mixed structured+media output; upstream
   wrappers may not collapse either transport first. All tools then use the
   existing pipeline: discovery → namespace/sanitize → output bound → guard →
   hooks → permission. Remote progress uses the distinct transient
   `brainstrike.mcp-progress.chunk` `writer.custom` part and maps back to a
   `tool-event`; progress-channel failure is warning-only and never replaces a
   completed tool result or the remote tool's primary error.

Primary references:
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/extensions/overview
- https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- https://github.com/modelcontextprotocol/typescript-sdk/blob/%40modelcontextprotocol%2Fclient%402.0.0/docs/migration/upgrade-to-v2.md

When changing this flow, update this section and the focused agent + desktop
real-protocol integration tests.
