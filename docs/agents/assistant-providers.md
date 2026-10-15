# Assistant providers and MCP

Use this contract when changing model catalogs, provider credentials, request
preparation, MCP configuration or tool discovery. The host admits concrete models
and executable tools; clients submit non-secret intent. Keep provider auth,
transcript ownership and transport negotiation as separate boundaries.

## Catalog and request ownership

Provider/model rows belong to
[the catalog](../../packages/assistant-contract/src/provider-catalog.json), with
strict validation and accessors in the same package. Derive authentication and
capability behavior from registry metadata rather than provider-name heuristics.
Pricing and model limits belong to the route that serves and bills the request;
provider-reported cost is authoritative, and catalog rates are estimates.

Catalog object keys are alphabetical at every depth, and that is enforced:
`findCatalogKeyOrderFailures` in `scripts/provider-catalog-key-order-guard.mjs`
enforces the order (`pnpm lint:catalog-key-order`), because Biome's
`useSortedKeys` assist does not reach JSON object keys. A wrong order fails
naming the entry; nothing is reordered for you. ROW order is deliberately
unchecked — providers and models are curated.

The built-in `local` provider is EMBEDDINGS-ONLY on both shells
(`capabilities.llm: false`): its chat model, engine and `llm-host` renderer role
were retired. It is configured in Settings → Embedding, not Settings →
Providers — it has neither a credential nor a connection — and the factory
refuses to build a chat model for it (the same derived refusal covers cohere
and voyage). Its registry runtime is `on-device`, which stays distinct from
`local` (an Ollama/LM Studio SERVER with a base URL). See
[local inference](local-inference.md).

Prepare provider history through
[the shared request boundary](../../packages/agent/src/provider-request.ts).
Keep executed tool provenance and OpenAI call/output identities distinct. Drop
orphaned reasoning, aborted-step items and foreign-provider executed parts from
requests without rewriting canonical history. API-key OpenAI uses stored
responses; subscription OpenAI sets unstored mode before request construction
and carries reasoning inline. Expired stored items are typed, non-retryable
failures; replaying without them requires the user's decision.

## Credentials and privacy

[ADR-0014](../adr/0014-provider-credentials-and-openai-storage.md) governs auth.
Thread typed credentials or authenticated fetch capabilities directly to their
consumer; model-facing context, run snapshots and public status/log events never
carry secrets. Dedicated credential operations retain their authenticated secret
store boundary. An admitted auth input is authoritative and cannot fall back to another
runtime/environment identity. Missing credentials and unreadable secrets are
different failures.

Bedrock precedence is environment bearer, stored bearer, environment chain,
stored chain. Resolve AWS chains only through the injected host capability.
Subscription OAuth requires its interactive desktop capability; renderer surfaces
receive account status, not tokens. Refresh has one owner, and disconnect fences
late work. Anthropic subscription OAuth remains rejected. Environment diagnostics
contain names, paths and loader messages, never secret values or fingerprints.

Owner: [provider auth](../../packages/host-capabilities/src/provider-auth.ts).

## MCP configuration and lifetime

Transport is explicit: stdio, Streamable HTTP or legacy SSE. Protocol policy is
separate; a failed connection or HTTP auth error cannot select another transport
or prove legacy negotiation. Read the actual negotiated capabilities, not a
package's latest-version constant. Registered extensions advertise only complete,
validated implementations for that connection's negotiated revision.

Configured-server authority and connection generations fence admitted tools,
resources, task handles, app frames and human input. Reconfiguration or close
retires their capabilities; restart verifies the captured non-secret authority
before rebuilding bindings. A credential record ID does not prove an unchanged
private principal. Missing authority refuses visibly.

Owner: [MCP host services](../../packages/host-capabilities/src/mcp/).

## Tools and saved choices

Keep authored validation, executor identity, permission identity and raw output
separate from bounded model projections. Strict provider schemas use representable
shapes without cross-field refinements; they tolerate declared cross-action fields
while rejecting genuinely unknown keys. Tool omissions and
projection truncation remain explicit.

[MCP settings authority](../../packages/host-capabilities/src/mcp/settings-authority.ts)
owns config and preferences. Merge writes preserve undiscovered tool IDs, refuse
unreadable preferences before changing the live registry, and use the shared file
lock. Discovery absence is not retirement; explicit reset deliberately replaces
saved choices. Protocol verification belongs to [MCP conformance](mcp-conformance.md).
