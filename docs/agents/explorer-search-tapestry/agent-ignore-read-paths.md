# Agent-ignore hard boundary on read paths — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "THE HARD BOUNDARY BINDS ON EVERY READ PATH".
Read before adding a workspace read path or changing createAgentIgnoreGuard.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '794,826p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

### THE HARD BOUNDARY BINDS ON EVERY READ PATH (BST-1432)

A `.llmignore` honoured by the file lister but not by grep is not a boundary —
it is a UI convenience that reads as a security control, which is the worse of
the two failures. `createAgentIgnoreGuard`
(`apps/desktop/src/assistant-server/agent-ignore-guard.ts`) is the hard layers
made queryable by arbitrary path, because ripgrep returns a flat path list with
no directory context and cannot use the walk's push/pop matcher.

| Read path | Enforced at |
| --- | --- |
| `globWorkspace` / walk | `walkWorkspaceRoot` matcher (layers 1-8) |
| live grep — ripgrep engine | `dropAgentIgnored`, where both engines converge |
| live grep — JS-walk engine | same call site, so parity cannot drift |
| excluded-path steering probe | its bounded eligible slice, before any read |
| `readWorkspaceFile` (paged) | inside the stable-path lock |
| `readWorkspaceTextFile` (LSP inspect, rename reindex, workspace-context, `@file`) | the shared reader, so consumers inherit it |

- **Why JS-side for both grep engines**, when `.gitignore` deliberately is not:
  rg implements gitignore natively, so delegating that layer risks two
  implementations disagreeing. `.llmignore` is not an rg ignore file at all, so
  there is no second implementation to diverge from.
- **Both grep engines are filtered at ONE call site.** Enforcing inside each
  collector would make the boundary's strength depend on whether `rg` is
  installed on the machine.
- **A refused read THROWS; it never returns empty content.** Empty content
  teaches the model the file is empty and it will report that as fact — a
  fabricated claim about the user's code. The message names the ignore files so
  the user can find the rule.
- **The guard is hard-layers-only.** Applying layers 1-6 there too would
  silently make `includeIgnored` useless on every path that consults it.
- Still uncovered, deliberately and tracked: file MUTATION tools do not consult
  the guard, so an agent can still write to an agent-ignored path (BST-1433).
