# @brainstrike/agent

Shared provider, request, tool, MCP and memory adapters. Run execution belongs to the shared agent host (`packages/agent-host`): one AI SDK loop per root or child run, with Mastra as a memory library behind it ([ADR-0012](../../docs/adr/0012-ai-sdk-loop-mastra-memory-library.md)).

## Entrypoints

[`package.json`](package.json) is the export map. Key boundaries:

| Import | Purpose |
| --- | --- |
| `@brainstrike/agent/client` | Browser-safe catalog, context and tool metadata |
| `@brainstrike/agent/provider-runtime` | Node host provider/auth/runtime composition |
| `@brainstrike/agent/provider-request` | Shared provider-history request preparation |
| `@brainstrike/agent/code-execution` | The code-executor seam |
| `@brainstrike/agent/mcp-client` | Explicit MCP transports and client |

- The root entry is broad and not guaranteed browser-safe; prefer the narrow subpaths.
- Never start a parallel Mastra loop or a renderer-owned transcript from this package.

## Rules

- Provider and model metadata belong to `@brainstrike/assistant-contract`.
- Pass resolved auth through the existing credential boundary; keep secrets out of serialized runtime data and diagnostics.
- MCP transport, executable tool identity and permission authority stay explicit.
- `test:integration` runs the real-fence suites; see [`fence-escape-resistance.README.md`](src/__tests__/fence-escape-resistance.README.md).
- Contracts: [providers](../../docs/agents/assistant-providers.md), [runtime](../../docs/agents/assistant-runtime.md), [Mastra](../../docs/agents/mastra-boundary.md), [code execution](../../docs/agents/code-execution.md).

MIT.
