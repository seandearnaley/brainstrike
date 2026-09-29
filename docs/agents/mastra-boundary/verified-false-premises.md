# Verified-false premises — evidence

Supports `docs/agents/mastra-boundary.md` § "VERIFIED-FALSE PREMISES". Each row
was checked against the installed package or the live tree at `8b6ccb92b`; they
are recorded so they are not re-derived.


Recorded so they are not re-derived. Each was checked against the installed
package or the live tree at `8b6ccb92b`.

| Premise carried by the tickets | Reality |
| --- | --- |
| Adopting Mastra Server means adopting a generated Hono app | Core has zero HTTP code; `hono`/`express` are not runtime deps |
| `RuntimeContext` is the Mastra type to migrate toward | The class is `RequestContext`; `RuntimeContext` is not a Mastra export |
| A bespoke desktop SSE MCP client needs replacing | Removed in #1593; the file is an 11-line shim over the SDK adapter |
| `@mastra/mcp` is present and duplicates a lifecycle | Not a dependency anywhere |
| Stream mapping is missing "cache chunks" | No such chunk type; prompt-cache usage is already on `message-finish.usage` |
| Structured object result is a reachable gap | `object`/`object-result` exist but are unreachable — `structuredOutput` is a rejected option (`runtime-assembly/stream-options.ts`'s `assertNoUnsupportedDirectStreamOptions`, called from `agent-streaming.ts`) |
| Evals are gated on the deployment boundary | `runEvals`/`createScorer` are in core; no server or storage required |
| Mastra Editor requires Mastra Cloud | `source: 'code'` is git-backed JSON |
| A CI eval entrypoint shipped in #1088 | The CLI is wired into **no** workflow; the eval logic is gated via vitest under `unit-shard` instead |
| Workspace/Browser/Editor are all core features | Only Workspace is; Browser needs a provider package, Editor ships types only |

