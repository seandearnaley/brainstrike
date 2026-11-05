# ADR-0023: The host owns its tool representation

- **Status:** Accepted by Sean; implemented. `HostToolDefinition` is exported from
  `@brainstrike/agent/tool-runtime` and `RuntimeData.mastraTools` is gone.
- **Date:** 2026-10-15
- **Follows:** ADR-0022 (web assistant as a stateless AI SDK proxy; that ADR is no longer in
  the repo, and `apps/web` has since been removed).
- **Amends:** [ADR-0012](0012-ai-sdk-loop-mastra-memory-library.md) (the `@mastra/core`
  peer-dependency clause) and ADR-0022 step 4 (its file count). File paths and line numbers
  below describe the tree on 2026-10-15; `packages/agent/src/mastra/` no longer exists.

## Context

ADR-0022 removed the Mastra agent loop's files but not the dependency, because the host's tool
pipeline was typed against Mastra's tool shape (`mastraTools?: ToolsInput`).

- **The host already owned a tool type.** `HostTool` (`packages/agent-host/src/ports.ts`) uses
  `ai`'s `FlexibleSchema` and `toModelOutput`.
  - Pipeline: producer → Mastra `ToolsInput` → `HostTool` → AI SDK `ToolSet`. Only the producer
    hop was the vendor's.
- **`RuntimeData.mastraTools` had no runtime reader after ADR-0022.** What remained were three
  type aliases borrowing its shape. `host-capabilities` imported nothing from Mastra.
- **A round-trip cast:** `native-web-search` cast an AI SDK tool to `ToolsInput` and
  `production-platform.ts` cast it back.
- **What `createTool` added on the host path was all overhead:**
  - a second input-validation pass whose `ValidationError` had to be detected;
  - an output-validation pass the MCP client neutralised with a pass-through schema;
  - a context reorganisation the host avoided by never setting `messages`;
  - suspend plumbing the host never used.

## Decision

1. **The host's tool representation is its own; `ToolSet` is what it converts to.**
   - New producer type `HostToolDefinition` in `@brainstrike/agent/tool-runtime`, using `ai`'s
     `FlexibleSchema`. The three aliases point at it; `RuntimeData.mastraTools` is deleted.
   - `HostTool` stays as the post-binding type because it carries host authority (`identity`,
     `risk`, `permissionToolId`, `mcpAuthority`, `consent`, `approvalTarget`).
   - `packages/agent` gains a direct, exactly pinned `ai` dependency in lockstep with
     `agent-host`.
2. **Every field of the vendor type has a named home or is deleted.**
   - `strict`, `toModelOutput`: already on AI SDK `Tool` and `HostTool`.
   - `inputSchema`, `resumeSchema`: declared on `HostToolDefinition`.
   - Documentation-only `outputSchema`: deleted (no reader; MCP SDK already validates
     `structuredContent`).
   - `mcp` (`_meta`, annotations): deleted; `_meta` reads stay inline where tools are built.
   - `mcpMetadata.appCapable`: deleted. The host admits MCP Apps calls per call on mount
     evidence (`decideHostMcpAppCall` requires a committed `effect.finished` that mounted that
     exact app), which is stronger than a declared capability.
   - `ToolExecutionContext`: replaced by `HostToolContext`.
   - `writer`: the host constructs `{ custom }` around `HostToolContext.write`. The two
     tolerated writer shapes and tool-call-id positions collapse to one each.
3. **JSON Schema 2020-12 composition survives without Mastra.** `jsonSchema(raw, { validate })`
   stores the schema verbatim. What preserves 2020-12 is not routing through zod.
   - MCP input is validated once, at `executableInputSchema`, with Ajv (via
     `@mastra/schema-compat/schema` or `ajv`). No "validate if a validator exists" path.
4. **No dual representation or shim.** Producers convert one at a time behind one type.
5. **Lands after all four ADR-0022 steps**, when `mastraTools` has no reader.
6. **This does not drop `@mastra/core`.** It remains a runtime dependency of `packages/agent` and
   `packages/agent-host` for:
   - hosted tool discovery (`ToolSearchProcessor`; `host-tool-discovery.ts` still calls
     `createTool` to feed it);
   - skills tooling;
   - provider-request shaping (`TripWire`, `TokenLimiter`, `Processor`, `ProviderHistoryCompat`,
     `ModelRouterLanguageModel`);
   - background tasks and the memory adapters ADR-0012 keeps.

   ADR-0012's "`@mastra/core` stays installed only as `@mastra/memory`'s peer" clause is
   amended to state this boundary, and `docs/agents/mastra-boundary.md` matches.
7. **ADR-0022 step 4 stops naming a file count** (severable; stands even if 1–6 were rejected).
   It is replaced by:

   > Delete every `src/mastra/` module that no surviving `package.json` export entry reaches and
   > no non-test consumer outside `packages/agent` imports — where e2e helpers count as tests and
   > are re-pointed, not preserved — recomputed immediately before the deletion lands.

   - Why: four sessions computed 83, 79, 75 and 69 retirable files, each from an incomplete seed.
     `./provider-request` and `./provider-runtime` alone reached 13 `src/mastra/` modules, and one
     e2e helper (`mcp-apps-ordinary-admission.ts`) swung the result between 27 and 66.

## Consequences

- The vendor tool type leaves the host pipeline.
  - Both `native-web-search` casts go.
  - Input is validated once, not twice.
  - The output-validation neutraliser, empty `RequestContext`, `noopObserve`, `ToolStream`
    wrapper and version-coupled `McpExecuteContext` slice disappear. A Mastra upgrade can no
    longer silently break progress streaming.
- Cost: about 25 non-test files, mostly `mcp-runtime-client.ts`, `canonical-context.ts`,
  `tool-model-output.ts` and `canonical-tool-bindings.ts`.
- Implementation order (each step compiles alone):
  1. Introduce `HostToolDefinition`; repoint aliases.
  2. Delete `RuntimeData.mastraTools`.
  3. Convert `createTool` producers (`mcp-runtime-client`; `ask-user` / `submit-plan` /
     `run-python`; `deferred-tool-catalog`).
  4. Replace the Mastra execution context and writer in `canonical-context.ts`.
  5. Consolidate input validation; delete `isValidationError`.
  6. Delete dead carriers.
- **Regression risk: MCP input validation on approval resume.** `approvalRuntimeSchema` returns
  an admitted input without validating, so Mastra's inner pass had been the only check. A test
  must fail if validation is removed there.
- Hosted tool discovery stays on `@mastra/core` and becomes the largest remaining Mastra surface;
  replacing it is a separate decision.
- `@mastra/memory` and the memory adapter are untouched (ADR-0012).

## Alternatives considered

- **Keep the vendor type.** Rejected: it keeps two unsound casts, double validation, a
  neutralised output schema and a silently degradable context, for a shape nothing reads.
- **Structural producer type with `inputSchema: unknown`, no `ai` dependency.** Rejected: swaps
  a type error for a runtime `TypeError`.
- **Move MCP tool construction into `agent-host`.** Probably the right end state, but a package
  move on top of a representation change (`@brainstrike/agent/mcp-client` had 17 import sites).
  Do it later on its own evidence.
- **Fold into ADR-0022 as a fifth step.** Rejected: its own blast radius across three packages.
- **Remove `@mastra/core` from `packages/agent` entirely.** Rejected: would also have to replace
  tool search, skills, provider processors and background tasks, each its own decision.

## Verification at decision time

- Verified by reading source and installed `dist` of `ai@7.0.126`,
  `@ai-sdk/provider-utils@5.0.53`, `@mastra/core@1.71.0`, `@mastra/schema-compat@1.3.11`, plus a
  static import walk for the seed counts.
- Not verified: nothing was executed. Ajv draft-07 vs 2020-12 `$defs` resolution, and whether
  any MCP server in use ships 2020-12 composition, were not tested.
