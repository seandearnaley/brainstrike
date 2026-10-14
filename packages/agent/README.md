# @brainstrike/agent

Shared provider, request, tool and memory adapters for Brainstrike. Desktop and
CLI run execution belongs to the shared agent host: one AI SDK loop per root or
child run. Mastra is a memory library behind that host adapter. See
[ADR-0012](../../docs/adr/0012-ai-sdk-loop-mastra-memory-library.md).

## Use the intended entrypoint

[`package.json`](package.json) is the authoritative export map. Important boundaries:

| Import | Purpose |
| --- | --- |
| `@brainstrike/agent/client` | Browser-safe catalog, context and tool metadata |
| `@brainstrike/agent/provider-runtime` | Node host provider/auth/runtime composition without browser inference registration |
| `@brainstrike/agent/provider-request` | Shared provider-history request preparation |
| `@brainstrike/agent/hosted-web` | Hosted server request/stream boundary without local inference or PGlite stores |
| `@brainstrike/agent/request-boundary` | Lightweight transport request-size configuration |
| `@brainstrike/agent/code-execution` | Existing code-executor seam |

The broad root entry registers browser-local inference and exports older adapters;
it is not a universally browser-, host- or edge-safe import. Do not start a
parallel Mastra loop or renderer-owned transcript from its legacy convenience
functions. Current host integration lives in `packages/agent-host`.

Provider/model metadata belongs to `@brainstrike/assistant-contract`. Pass resolved
auth through the existing credential boundary, keeping secrets out of serialized
runtime data and public diagnostics. MCP transport, executable tool identity and
permission authority remain explicit.

Local workspace consumers declare `"@brainstrike/agent": "workspace:*"`. Use the
repository catalogs/overrides and installed manifests for dependency versions;
there is no separate peer-install recipe.

## Development

From this package, `pnpm build`, `pnpm type-check`, `pnpm test` and
`pnpm test:integration` use the existing configured build/check paths.
**CI is disabled due to cost; validation must run locally.** Select checks with
[validation guidance](../../docs/agents/ci-quality.md).

Contracts: [providers](../../docs/agents/assistant-providers.md),
[runtime](../../docs/agents/assistant-runtime.md),
[Mastra](../../docs/agents/mastra-boundary.md) and
[code execution](../../docs/agents/code-execution.md).

MIT. See the package manifest and repository third-party notices.
