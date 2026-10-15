# ADR-0023: The host owns its tool representation

- **Status:** Proposed
- **Date:** 2026-10-15
- **Ticket:** none yet
- **Follows:** [ADR-0022](0022-web-assistant-stateless-ai-sdk-proxy.md)
- **Amends:** [ADR-0012](0012-ai-sdk-loop-mastra-memory-library.md) (one clause; see Decision)
- **Evidence:** `docs/archive/host-tool-representation-measurement-2026-10-15.md`

## Context

ADR-0022 retires the Mastra agent loop once `apps/web` stops calling it. Its four
steps remove the engine's files. They do not remove the dependency, because the
host's tool pipeline is typed against the vendor's tool shape:
`packages/agent/src/types.ts:164` declares `mastraTools?: ToolsInput`, and
`packages/agent-host/src/adapters/canonical-tool-bindings.ts:26` declares
`type CanonicalTools = NonNullable<RuntimeData['mastraTools']>`.

Measuring that from the code corrected three assumptions, including two of my
own in the note that commissioned this ADR.

**The host already owns a tool type.** `HostTool`
(`packages/agent-host/src/ports.ts:462`) declares `inputSchema:
FlexibleSchema<unknown>` and `toModelOutput: Tool<unknown, unknown>['toModelOutput']`,
both imported from `ai`. The pipeline runs three hops — producer →
`ToolsInput` → `HostTool` → AI SDK `ToolSet` — and only the middle one is the
vendor's. The question is not whether the host needs its own representation. It
has one. The question is whether the **producer** hop should be the vendor's.

**After ADR-0022, `RuntimeData.mastraTools` has no runtime reader.** Its only two
readers are `agent-streaming.ts:1869` (the engine) and `message-utils.ts:290`
(the web `toAiSdkStyleStream` path ADR-0022 removes). What survives is three
`type X = NonNullable<RuntimeData['mastraTools']>` aliases, in
`canonical-tool-bindings.ts`, `host-capabilities/src/native-tools/executors.ts`
and `host-capabilities/src/mcp/mcp-tool-binding.ts`, borrowing a dead field's
type as shape vocabulary. `packages/host-capabilities` declares no `@mastra/*`
dependency at all and imports nothing from Mastra; thirteen of its fifteen
native-tool entries are already plain object literals.

**The clearest symptom is a round-trip cast.**
`providers/native-web-search.ts:93` builds a genuine AI SDK provider tool and
casts it `as unknown as ToolsInput[string]`;
`agent-host/src/production-platform.ts:177` casts it back `as unknown as Tool`.
Two unsound casts around a value that was an AI SDK tool at both ends.

What `createTool` contributes on the host path is a second input-validation pass
whose `ValidationError` carrier `tool-model-output.ts:204` then has to detect; an
output-validation pass that `mcp-runtime-client.ts:375` exists solely to
neutralise with a `validate: (value) => ({ value })` schema; a context
reorganisation the host avoids only by never setting `messages`; and suspend
plumbing the host never uses, because `sdk-tools.ts:28` builds interaction tools
without an `execute` at all.

## Decision

**1. The host's tool representation is its own, and the AI SDK's `ToolSet` is
what it converts to — not what it starts from.**

Introduce one producer-side type, `HostToolDefinition`, exported from
`@brainstrike/agent/tool-runtime` beside `RuntimeData`, declared in terms of
`ai`'s `FlexibleSchema`. Repoint the three aliases at it and delete
`RuntimeData.mastraTools`. `HostTool` stays the host's post-binding type and
`ToolSet` stays the edge. The intermediate type does not disappear — two
representations is the right number here, because `HostTool` carries host
authority (`identity`, `risk`, `permissionToolId`, `mcpAuthority`, `consent`,
`approvalTarget`) that a producer has no business declaring. What disappears is
the vendor's.

This requires adding `ai` (catalog-pinned, the same exact 7.0.126 `agent-host`
uses) to `packages/agent`, which today depends on five `@ai-sdk/*` packages but
not on `ai` itself.

**2. Every item the vendor type carries has a named home.** Per the measurement:

- `strict` — nowhere new. It is on AI SDK 7's own `Tool`
  (`provider-utils/src/types/tool.ts:211`) and already on `HostTool.strict`.
- `toModelOutput` — nowhere new. `HostTool.toModelOutput` is already *declared
  as* the AI SDK's.
- `inputSchema`, `resumeSchema` — declared directly on `HostToolDefinition`.
- `outputSchema` (the documentation-only one) — **deleted**. It has no reader; it
  exists only to defeat Mastra's own output validation, and the MCP SDK has
  already validated `structuredContent`.
- `mcp` (`MCPToolProperties`: `_meta`, annotations) — **deleted**. No reader in
  `agent-host` or `host-capabilities`. The `_meta` reads (`readStrictMeta`,
  `stampServerIdInMeta`) stay inline where the tool is built.
- `mcpMetadata` — server identity is already `HostTool.mcpBinding` +
  `mcpAuthority`. `appCapable` has **no host reader today**: its only consumer,
  `mastra/mcp-app-tool-call.ts`, is called from the engine alone. It gets a home
  on `HostTool.mcpBinding` when a host-side MCP Apps admission exists, and not
  before. Stated as an open item rather than resolved by guesswork.
- `ToolExecutionContext` slice — **`HostToolContext`** (`ports.ts:137`), which is
  already richer and already what `createCanonicalToolContext` converts *from*.
  The `requestContext`/`parseMemoryRequestContext` branch in
  `tools/read-tool-call-id.ts:46` is unreachable on the host path and goes with
  it.
- `writer` — **the host already supplies it.** `ToolStream.custom(data)` is
  `await this.writeFn(data)`, and the host already constructs the `ToolStream`
  around `HostToolContext.write` (`canonical-context.ts:34`). The host
  constructs `{ custom }` instead. `ShellOutputWriter`
  (`mastra/shell-output-stream.ts:16`) is already a local interface with no
  Mastra type, and `tool-execute-support.ts:157` already consumes the writer
  structurally. Its two tolerated writer shapes and two tolerated
  tool-call-id positions — which exist only because Mastra passes one shape to
  `createTool` instances and another to plain objects — collapse to one each.
  This was expected to be the subtle part. It is the easy part.

**3. JSON Schema 2020-12 composition survives, and Mastra is not what preserves
it.** `jsonSchema(raw, { validate })` stores the schema verbatim and
`Schema.jsonSchema` is, in the AI SDK's own words, "passed to the providers";
`asSchema` returns it unchanged. Mastra's `toStandardSchema` on a raw JSON
Schema is a `JSON.parse(JSON.stringify(...))` clone plus a `$schema` stamp — not
a conversion — and `@mastra/core/schema` is a two-line re-export of
`@mastra/schema-compat/schema`, which has no `@mastra/core` dependency. What
preserves 2020-12 is **not routing through zod**, which `jsonSchema()` does
natively.

The one thing Mastra's wrapper supplies that `jsonSchema()` does not is the
**Ajv validator**. MCP input validation is kept, not dropped: the host validates
once, at `executableInputSchema`, with an Ajv validator obtained either from
`@mastra/schema-compat/schema` (already a direct `agent-host` dependency, zero
behaviour change) or from `ajv` directly. Removing the second pass must not
remove the first. There is no "validate if a validator happens to exist" path.

**4. No dual representation and no compatibility shim.** A producer that still
constructs a Mastra `Tool` structurally satisfies `HostToolDefinition` while it
is being converted, so the conversion proceeds producer by producer behind one
type. At no point are two tool types in the pipeline, and no runtime switch
selects between them.

**5. This lands after all four of ADR-0022's steps.** Reason: the decisive
enabler — `mastraTools` having no runtime reader — is only true once the engine
and the web path are gone. Doing it earlier means keeping the field alive for two
readers that are about to be deleted, which is the dual-representation state this
ADR forbids, and rewriting types inside a directory that step 2 is about to move.

**6. This does not drop `@mastra/core`, and must not be sold as if it did.**
After this change `@mastra/core` remains a runtime dependency of
`packages/agent` and `packages/agent-host` for: hosted tool discovery
(`mastra/tool-search-runtime.ts` constructs a real `ToolSearchProcessor`, and
`agent-host/src/adapters/host-tool-discovery.ts` calls `createTool` purely to
feed it); skills (`createSkillTools`, `formatSkillActivation`,
`formatSkillsCatalog`, `WorkspaceSkills`); provider-request shaping (`TripWire`,
`TokenLimiter`, `Processor`, `ProviderHistoryCompat`, `ModelRouterLanguageModel`);
background tasks; and the memory adapters ADR-0012 keeps. **ADR-0012's clause
"`@mastra/core` stays installed only as [`@mastra/memory`'s] peer" is amended to
state the actual boundary**, and `docs/agents/mastra-boundary.md` is updated to
match. Making a false statement true by deleting the thing that contradicts it is
the wrong order of operations; the statement was always wrong.

## Consequences

- The vendor tool type leaves the host pipeline. Both `native-web-search` casts
  go. Input is validated once instead of twice. The output-validation neutraliser,
  the empty `RequestContext`, `noopObserve`, the `ToolStream` wrapper and the
  VERSION-COUPLED `McpExecuteContext` slice (`mcp-runtime-client.ts:390-401`) all
  disappear, and with them the class of silent degradation that comment warns
  about: a Mastra upgrade relocating `writer` under `agent` can no longer
  quietly stop progress streaming.
- **Cost: roughly 25 non-test files**, concentrated in four — `mcp-runtime-client.ts`
  (the only substantial rewrite), `canonical-context.ts`, `tool-model-output.ts`
  and `canonical-tool-bindings.ts`. The rest is type annotations, because the
  producers already emit plain objects. `host-capabilities` changes are three
  alias lines plus collapsing the dual writer shapes; `apps/desktop` changes are
  three executor files (`native-tool-executors-{worktree,sessions,python}.ts`,
  the last because `createRunPythonTool` is a `createTool` producer the host
  platform wires in through `agent-host-platform/host-executed-tools.ts:26`).
- Suggested order, each step compiling on its own: (i) introduce
  `HostToolDefinition` and repoint the three aliases — type-only, and the
  typecheck proves the existing producers already satisfy it; (ii) delete
  `RuntimeData.mastraTools`; (iii) convert the `createTool` producers —
  `mcp-runtime-client`, then `ask-user`/`submit-plan`/`run-python`, then
  `deferred-tool-catalog`; (iv) replace the Mastra execution context and writer
  in `canonical-context.ts`; (v) consolidate input validation and delete
  `isValidationError`; (vi) delete the now-dead carriers.
- `packages/agent` gains a direct `ai` dependency, pinned exactly, which must stay
  in lockstep with `agent-host`'s. ADR-0012 already requires `ai` to be pinned
  exactly, so this adds a second place to bump, not a new policy.
- **Regression risk is concentrated in MCP input validation.** Today two Ajv
  passes run over the same schema; after this, one does. The approval-resume path
  is where that matters: `approvalRuntimeSchema` returns an admitted input
  *without* validating, so Mastra's inner pass is currently the only validation a
  resumed call gets. A test must fail before the change if validation is removed
  there. This is the one place where "it still works" and "it silently stopped
  checking" look identical.
- Hosted tool discovery stays on `@mastra/core` and becomes the single largest
  remaining Mastra surface in the host (`tool-search-runtime.ts`, 753 lines, plus
  `host-tool-discovery.ts`'s `createTool` calls). Whether to keep borrowing
  Mastra's BM25 tool-search processor is a separate decision with its own
  evidence; this ADR scopes it out rather than pretending it follows.
- `@mastra/memory` and `agent-host`'s memory adapter are untouched, per ADR-0012.

### Correction carried into ADR-0022's step 4

ADR-0022's deletion list (82, corrected to 83 files) was computed from a
tool-projection seed that does not include the two public entries the host
imports. Walking from `packages/agent/src/tool-runtime.ts` and
`packages/agent/src/mcp-client.ts` reaches nine further `src/mastra/` modules —
`default-instructions`, `tool-search-runtime`, `mcp-tool-loader`,
`plan-mode-tool-gate`, `stream-run-event-chunks`, `mcp-discovery-diagnostics`,
`deferred-tool-catalog`, `mastra-agent-error`, `deferred-capability-families` —
each with at least one consumer outside `packages/agent`.

| Set | Files | Lines |
| --- | ---: | ---: |
| `src/mastra/` non-test, total | 100 | 32,847 |
| Seeded tool-projection cluster (reproduces the scoping doc's 16 / 4,983) | 16 | 4,967 |
| Union with the `tool-runtime` + `mcp-client` entry closures | **25** | **7,517** |
| Retirable | **75** | **25,330** |

This does not change ADR-0022's decision — web still stops calling the loop, and
the deletion is still the largest subtraction available. It changes which files
step 4 may delete, and should be settled there, not here.

## Alternatives considered

- **Leave it and accept the vendor type.** The legitimate do-nothing option, and
  the one to pick if the cost were high. It is not: the producers already emit
  plain objects, the field is already dead, and three type aliases are the whole
  structural coupling. Rejected because leaving it keeps two unsound casts, a
  duplicated validation pass, a deliberately neutralised output schema and a
  context slice the code itself marks as able to degrade silently on a version
  bump — all to express tools in a shape nothing on the host path reads.
- **Declare the producer type structurally, with `inputSchema: unknown`, and
  keep `ai` out of `packages/agent`.** Cheapest, and matches today's seam, since
  `canonicalToolInputSchema(schema: unknown)` already takes `unknown`. Rejected:
  it replaces a wrong type with a weak one and moves the failure from the
  typechecker to a runtime `TypeError`, for the sake of not declaring a
  dependency on a package whose five providers `packages/agent` already depends
  on.
- **Move MCP tool construction out of `packages/agent` into `agent-host`, where
  `ai` already lives.** The cleanest end state and probably where this wants to
  end up. Rejected *for this change*: it is a package-boundary move on top of a
  representation change, and the public `@brainstrike/agent/mcp-client` entry
  that reaches `mcp-runtime-client.ts` has 17 import sites across the host
  packages, with `collectCombinedTools` alone consumed by seven files outside
  `packages/agent`. Worth doing on its own evidence, afterwards.
- **Fold this into ADR-0022 as a fifth step.** Rejected. It is a representation
  decision with its own blast radius across three packages, not a cleanup step,
  and its decisive enabler only becomes true once ADR-0022's four steps have
  landed.
- **Chase `@mastra/core` out of `packages/agent` entirely in one change.** The
  only way to make ADR-0012's peer-dependency clause literally true. Rejected on
  measurement: it would additionally have to replace Mastra's tool-search
  processor, the skills tooling, four provider-request processors and the
  background-task projection — none of which is a tool representation, and each
  of which deserves its own decision.

## What was verified, and what was not

Verified by reading source and the installed `dist` of `ai@7.0.126`,
`@ai-sdk/provider-utils@5.0.53`, `@mastra/core@1.71.0` and
`@mastra/schema-compat@1.3.11`: the three-hop pipeline and both casts; that
`mastraTools` has no surviving runtime reader; that `createTool`'s `execute`
validates input and output and reorganises context; that `ToolStream.custom` is a
one-line pass-through; that `@mastra/core/schema` re-exports
`@mastra/schema-compat/schema`; that `toStandardSchema` on raw JSON Schema is a
clone plus `$schema` stamp; that AI SDK 7's `jsonSchema()` stores JSON Schema
verbatim and `asSchema` returns it unchanged; that `strict` exists on AI SDK 7's
`Tool`; and the file and line counts in the table above, by a static import walk.

Not verified: **nothing was executed.** No test was run and no behaviour was
exercised. Whether Ajv's draft-07 engine resolves `#/$defs/...` pointers
identically to its 2020-12 engine was not tested — it matters only for an MCP
server using `$defs` without declaring `$schema`. Whether any MCP server actually
in use ships 2020-12 composition was not measured; the preservation claim is
about the code path, not observed traffic. The import walk resolves relative
specifiers only, so a module reached by a computed specifier would be missed.

## Recommendation

Accept 1-5 and amend ADR-0012 per 6. The representation change is worth making
and smaller than it looked; the dependency removal it was hoped to deliver is
not within reach, and the honest move is to correct the claim rather than keep
chasing it.
