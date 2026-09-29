# R7 MCP capability matrix — evidence

Supports `docs/agents/mastra-boundary.md` § "R7 MCP TRANSPORT AND CAPABILITIES".
Read this for why `@mastra/mcp` stays out. Corrected 2026-09-21: the capability
matrix below is a 1.51-era snapshot and is obsolete in three rows — elicitation
is implemented (`apps/desktop/src/mcp/elicitation-bridge.ts`,
`elicitation-presenter.ts`, BST-1584), OAuth is implemented
(`apps/desktop/src/mcp/oauth-client-provider.ts`, `oauth-client-registration.ts`,
`oauth-loopback-callback.ts`, `oauth-safe-storage-defaults.ts`), and
resources/templates/prompts are served by
`apps/desktop/src/mcp/core-server-features.ts`. The named desktop `sse-client.ts`
shim no longer exists at all. Current MCP capability state is owned by
`docs/agents/assistant-providers.md` and `docs/agents/mcp-conformance.md`; the
cross-reference below to `assistant-providers.md:400` is now
`assistant-providers.md:2357`, same heading.


**Transport selection is already ruled.** See
`docs/agents/assistant-providers.md:400`, `## MCP TRANSPORT SELECTION (CRITICAL)`:
explicit `stdio` / `streamable-http` / `sse` per server, official
`@modelcontextprotocol/sdk` clients only, and **no** automatic Streamable HTTP → SSE
fallback. That ruling stands unchanged; this section only adds the capability
matrix BST-559 asked for.

`@mastra/mcp` is **not** a dependency — zero hits across every `package.json`, the
lockfile, and `node_modules/.pnpm`. Reintroducing it is rejected: it would create a
second connection lifecycle alongside the SDK clients for no capability the SDK
lacks. The desktop `sse-client.ts` is an 11-line compatibility shim over the
SDK-backed adapter, not a bespoke client (#1593).

| Capability | Status | Ruling |
| --- | --- | --- |
| Tool approval | implemented (`permission-tool-gate.ts:67-86`) | keep; unclassified MCP tools default to risk `mcp`, never `read` |
| Progress | implemented in agent runtime (`mcp-runtime-client.ts:224-242`); plumbed-but-unused in desktop | keep; desktop wiring is optional |
| Custom fetch | seam exists, no production caller (`explicit-http-client.ts:24,144`) | keep the seam |
| Resources / templates / prompts | not implemented | **out of scope** — no product need; these are Brainstrike gaps, not SDK gaps |
| Elicitation | not implemented | **out of scope** — overlaps the existing tool-approval and suspension UIs |
| OAuth | not implemented | **blocked**, not rejected — requires a secrets and redirect/callback boundary that does not exist |

