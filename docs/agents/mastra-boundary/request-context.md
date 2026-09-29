# R5 RequestContext — evidence

Supports `docs/agents/mastra-boundary.md` § "R5 REQUEST CONTEXT". Read this
before putting anything new in a `RequestContext`. Corrected 2026-09-21: "Today
exactly two product imports exist" is no longer true — `RequestContext` is also
imported by `packages/agent/src/mastra/delegated-conversation-binding.ts`,
`delegated-system-context.ts`, `delegated-turn-persistence.ts`,
`delegated-step-usage.ts`, `delegated-work-budget.ts`,
`child-continuation-usage.ts`, `build-persona-subagents.ts`,
`runtime-assembly/tool-pipeline.ts`, `tools/read-tool-call-id.ts`,
`providers/provider-auth-input.ts` and
`packages/assistant-ui/src/data-stream-runtime.ts`. The count was a snapshot, not
the rule: the rule is that no `RuntimeData` field and no product state travels
through the context, which those call sites still honour (correlation keys,
Mastra-reserved keys, and ephemeral native-call identity only).


**Brainstrike `RuntimeData` is the authoritative request-scoped carrier.
`RequestContext` is limited to Mastra-reserved keys.**

Today exactly two product imports exist:

- `packages/agent/src/mastra/tool-search-runtime.ts` uses
  `MASTRA_THREAD_ID_KEY` to expose Mastra's thread identifier to tool search.
- `packages/agent/src/mastra/thread-title-generation.ts` (moved out of
  `agent-streaming.ts` by BST-1649) creates a fresh, empty `RequestContext` for
  thread-title model resolution and generation. That context remains
  Mastra-only: Brainstrike does not add product or `RuntimeData` fields to it.

The delegated conversation binding adapter uses the child RequestContext only
as a WeakMap key for ephemeral native-call correlation. It adds no entries and
copies no RuntimeData; the host persistence callback travels as a direct runtime
option. Snapshot-resume authorization must read durable host state instead.

Zero of `RuntimeData`'s 43 contract fields
(`packages/assistant-contract/src/runtime-data.ts:216-342`) travel through either
context.

Three field classes, and the third is the reason this ruling is narrow:

1. **Wire-carried** (client → server): ~30 fields; web narrows to 19 forwarded + 8
   accepted-and-ignored, everything else 400s
   (`apps/web/src/server/web-assistant-runtime-schema.ts:164-224`).
2. **Server-injected, never serialized**: `signal`, `steering`, `taskList`,
   `workspaceRoots`, `apiKey`, `callTool`, and every agent-only field in
   `packages/agent/src/types.ts:110`.
3. **Client-supplied then stripped and re-derived server-side**:
   `permissionPolicy`, `hookRunner`, `mcpConfig`, `personaProviderApiKeys`,
   `workspaceSkills` (`prepareRequestSkillsFromDisk` in
   `packages/assistant-service/src/stream-init.ts`), and
   `workspaceRoots` (`stripClientWorkspaceRoots`, same file). The code comment states
   the rule: *"TypeScript types alone are not a request trust boundary."*

**Explicit non-goal:** migrating class 3 into `RequestContext`.
`RequestContext.toJSON()` **silently drops** functions, symbols, and circular refs
rather than throwing, and `RequestContext` is a typed Map with no trust semantics.
Routing stripped-and-re-derived fields through it would move a security boundary
onto a structure that cannot enforce one.

Migrating class 1 is permitted but unmotivated; it buys nothing today.

> Naming note: the Mastra class is `RequestContext`. `RuntimeContext` no longer
> exists — it appears in the package only inside a vendored AI-SDK type stub.
> Tickets and docs saying "RuntimeContext" are naming a symbol that is not a
> Mastra export.

