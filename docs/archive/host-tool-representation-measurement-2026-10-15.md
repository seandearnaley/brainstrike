# Host tool representation: measurement record

Evidence for [ADR-0023](../adr/0023-host-owns-its-tool-representation.md).
Measured on `main` at `6a0d027b6` (the task was scoped at `da3db1697`; the four
commits between them touch scripts, docs and tests, not `packages/agent`,
`packages/agent-host` or `packages/host-capabilities`). Analysis only — no
source was edited.

Installed versions used for every claim below: `ai@7.0.126`,
`@ai-sdk/provider-utils@5.0.53`, `@mastra/core@1.71.0` (patched),
`@mastra/schema-compat@1.3.11`, `@mastra/memory@1.32.1`, `zod@4.6.5`.

---

## 1. The pipeline has three hops, not two

| Hop | Produced by | Type |
| --- | --- | --- |
| 1 | `host-capabilities/src/native-tools/executors.ts`, `agent/src/mastra/mcp-runtime-client.ts`, `agent/src/tools/{ask-user,submit-plan,run-python}-tool.ts`, `agent/src/providers/native-web-search.ts` | `ToolsInput` (`@mastra/core/agent`) |
| 2 | `agent-host/src/adapters/canonical-tool-bindings.ts` | `HostTool` (`agent-host/src/ports.ts:462`) |
| 3 | `agent-host/src/sdk-tools.ts` → `createAdmittedHostSdkTools` (`run-admission.ts:627`) | `ToolSet` (`ai`) |

The host already owns a tool type. `HostTool` carries `inputSchema:
FlexibleSchema<unknown>` and `toModelOutput: Tool<unknown, unknown>['toModelOutput']`
— both imported from `ai`, not from Mastra. The open question is therefore not
"should the host have its own representation" but "should hop 1 be the vendor's".

### The round-trip cast

`agent/src/providers/native-web-search.ts:93` builds a real AI SDK provider tool
and casts it away:

```ts
return anthropicProvider.tools.webSearch_20250305() as unknown as ToolsInput[string];
```

`agent-host/src/production-platform.ts:177` casts it straight back:

```ts
const tool = createProviderNativeWebSearchTool(provider, auth) as unknown as Tool | undefined;
```

Two unsound casts around a value that was an AI SDK tool at both ends.

### Native tools are already plain objects

Thirteen of the fifteen entries in `SHARED_NATIVE_TOOL_EXECUTORS`
(`host-capabilities/src/native-tools/executors.ts`) are object literals of the
form `{ description, execute, id, inputSchema, toModelOutput? }`. They never
call `createTool`. `host-capabilities` declares **no** `@mastra/*` dependency
and imports nothing from Mastra — its coupling is one type alias at
`executors.ts:61`. The two exceptions are `createAskUserTool()` and
`createSubmitPlanTool()`, which do call `createTool` for their suspend/resume
schemas.

---

## 2. `RuntimeData.mastraTools` has no runtime reader after ADR-0022

Every non-test reference in the repository:

| Site | Kind | Survives ADR-0022? |
| --- | --- | --- |
| `agent/src/types.ts:164` | declaration | the field itself |
| `agent/src/mastra/agent-streaming.ts:1869-1870` | **read** | no — engine |
| `agent/src/message-utils.ts:290-291` | **read** | no — the web `toAiSdkStyleStream` path ADR-0022 removes |
| `agent-host/src/adapters/canonical-tool-bindings.ts:26` | `type CanonicalTools = NonNullable<…>` | yes |
| `host-capabilities/src/native-tools/executors.ts:61` | `type MastraTools = NonNullable<…>` | yes |
| `host-capabilities/src/mcp/mcp-tool-binding.ts:16` | `type CanonicalTools = NonNullable<…>` | yes |

After ADR-0022 the field is dead data whose **type** three aliases borrow as
shape vocabulary. Nothing writes it and nothing reads it.

---

## 3. What `createTool` actually contributes on the host path

`createTool` returns a `Tool` instance whose `execute` wraps the author's
callback (`@mastra/core/dist/tool-D87M4CXT.js`, lines 721-830). On the host path
it contributes five things:

1. **A second input validation pass.** `validateToolInput(this.inputSchema, …)`
   (`:729`) runs Ajv and, on failure, **returns** a `ValidationError` carrier
   `{ error: true, message, validationErrors }` rather than throwing. This is the
   carrier `agent/src/mastra/tool-model-output.ts:204,216` detects with
   `isValidationError`. The host already validates the same input at the SDK
   boundary (`approvalRuntimeSchema` → `executableInputSchema` → the same Ajv
   validator), so the pass is duplicated — except on the approval-resume path,
   where `approvalRuntimeSchema` returns the admitted value without validating
   and Mastra's inner pass is the only one.
2. **Output validation the code then neutralises.** `:818` calls
   `validateToolOutput(this.outputSchema, …)`. `mcp-runtime-client.ts:375-385`
   exists solely to defeat it: `createDocumentationOnlyMcpOutputSchema` returns a
   Standard Schema whose `validate` is `(value) => ({ value })`, because the MCP
   SDK has already validated `structuredContent`.
3. **Context reorganisation.** When `toolCallId && messages` are both present,
   `Tool.execute` moves the flat context under `{ agent: { … } }`. The host's
   `createCanonicalToolContext` never sets `messages`, so the flat shape is what
   reaches the MCP executor today. This — not the writer — is what the
   VERSION-COUPLED warning at `mcp-runtime-client.ts:390-401` is about.
4. **Suspend/resume plumbing**, used by Mastra's loop. The host never uses it:
   `sdk-tools.ts:28-29` builds interaction tools (`askUser`, `submitPlan`)
   **without** an `execute`, so `createAskUserTool()`'s suspend branch is dead on
   the host path. The host borrows only `description`, `inputSchema` and
   `resumeSchema` from those two tools.
5. **Schema normalisation**, `toStandardSchema(opts.inputSchema)` — see §4.

---

## 4. JSON Schema 2020-12 survives, and Mastra is not what preserves it

Four verified facts.

**(a) `@mastra/core/schema` is a two-line re-export.**
`@mastra/core/dist/schema/index.js` in full:

```js
import { isStandardSchemaWithJSON, standardSchemaToJSONSchema, toStandardSchema } from "@mastra/schema-compat/schema";
export { isStandardSchemaWithJSON, standardSchemaToJSONSchema, toStandardSchema };
```

`@mastra/schema-compat@1.3.11` depends on `json-schema-to-zod` and
`zod-from-json-schema`, peer `zod`. It does **not** depend on `@mastra/core`. It
is already a direct dependency of `packages/agent-host`
(`@mastra/schema-compat: catalog:`), used by `provider-schema-selection.ts` for
the provider compat layers.

**(b) For raw JSON Schema, `toStandardSchema` is a clone pass-through plus Ajv.**
`schema-compat/dist/json-schema-DaHLYDhg.js`, `JsonSchemaWrapper#toJsonSchema`:

```js
const clonedSchema = JSON.parse(JSON.stringify(this.#schema));
if (!clonedSchema.$schema) switch (target) {
  case "draft-07": clonedSchema.$schema = "http://json-schema.org/draft-07/schema#"; break;
  …
}
return clonedSchema;
```

There is **no conversion**. `target: 'draft-07'` only stamps `$schema` when the
schema carries none; `$defs`, `$ref` and `oneOf` are copied verbatim. Validation
compiles with `ajv/dist/2020` when `$schema` contains `"2020-12"`, otherwise with
draft-07 Ajv.

**(c) AI SDK 7 stores raw JSON Schema verbatim and hands it to providers.**
`@ai-sdk/provider-utils@5.0.53` `src/schema.ts`:

```ts
/** The JSON Schema for the schema. It is passed to the providers. */
readonly jsonSchema: JSONSchema7 | PromiseLike<JSONSchema7>;
```

`jsonSchema(schema, { validate })` stores `schema` behind a getter and returns a
branded `Schema`. `asSchema` returns a `Schema` **unchanged** (`isSchema` branch,
`:151`) — the narrowing transforms (`addAdditionalPropertiesToJsonSchema`,
`zod4Schema`'s `toJSONSchema({ target: 'draft-7' })`) are only on the
Standard-Schema and zod branches.

**(d) The host already bypasses the Standard-Schema branch.**
`agent-host/src/executable-input-schema.ts` rebuilds every non-zod standard
schema as a plain `Schema`:

```ts
return jsonSchema(() => converter.input({ target: 'draft-07' }), {
  validate: async (value) => { … standard.validate(value) … },
});
```

Because that returns a `Schema`, `asSchema` short-circuits and
`addAdditionalPropertiesToJsonSchema` never runs on an MCP schema.

**Conclusion.** Raw JSON Schema passes through AI SDK 7 intact. 2020-12
composition is preserved by *not routing through zod*, which `jsonSchema()` does
natively. The only thing Mastra's wrapper supplies that `jsonSchema()` does not
is **the Ajv validator**. Removing it without a replacement would silently delete
MCP input validation.

Note for honesty: for **native** (zod) tools, `canonicalToolInputSchema`'s
`toStandardSchema` call is effectively a no-op — the wrapper keeps
`~standard.vendor === 'zod'`, `executableInputSchema` returns it untouched, and
`asSchema` re-derives the JSON Schema from the zod schema itself. Mastra's
converter is load-bearing only on the MCP raw-JSON-Schema path.

---

## 5. Per-item homes

| Carried thing | Who reads it on the host path | Where it goes |
| --- | --- | --- |
| `strict` | `canonical-tool-bindings.ts:132` → `sdk-tools.ts:26` | nowhere new. `strict?: boolean` is on AI SDK 7's own `Tool` (`provider-utils/src/types/tool.ts:211`) and already on `HostTool.strict`. |
| `toModelOutput` | `canonical-tool-bindings.ts:145` | nowhere new. `HostTool.toModelOutput` is *declared as* `Tool<unknown, unknown>['toModelOutput']` from `ai`. |
| `inputSchema` | `canonicalToolInputSchema` → `executableInputSchema` → `approvalRuntimeSchema` | `jsonSchema(raw, { validate })` directly. Needs an Ajv validator — see §4. |
| `resumeSchema` | `canonicalInteraction` (`canonical-tool-bindings.ts:87`) | declared directly on the producer object; `canonicalToolInputSchema` already normalises it. |
| `outputSchema` (documentation-only) | **nobody.** It exists only to defeat `Tool.execute`'s `validateToolOutput`. | deleted. |
| `mcp` (`MCPToolProperties`: `_meta`, annotations) | **nobody.** `readStrictMeta(_meta)` and `stampServerIdInMeta` run at build time; the `mcp` property itself has no reader in `agent-host` or `host-capabilities`. | deleted; the `_meta` reads stay inline where the tool is built. |
| `mcpMetadata` (`{serverName, appCapable}`) | only `agent/src/mastra/mcp-app-tool-call.ts`, whose sole callers are `agent-runtime.ts:79` and `runtime-assembly/tool-pipeline.ts:52` — both engine. | server identity is already `HostTool.mcpBinding {configuredServerId, generation}` + `mcpAuthority`. `appCapable` has **no host reader today**; it needs a home only when a host-side MCP Apps admission exists. Open item, stated rather than resolved. |
| `writer` (progress streaming) | `host-capabilities/src/native-tools/tool-execute-support.ts:171` | the host already supplies the sink. See below. |
| `ToolExecutionContext` slice (`agent`/`writer`/`abortSignal`) | `mcp-runtime-client.ts:403` | `HostToolContext` (`ports.ts:137`), which is already richer and already the thing `createCanonicalToolContext` converts *from*. |
| `requestContext` / `parseMemoryRequestContext` | `agent/src/tools/read-tool-call-id.ts:46` | unreachable on the host path: `readExecutionIdentity` finds the top-level `threadId` that `createCanonicalToolContext` sets, and returns before the `RequestContext` branch. The host constructs `new RequestContext()` empty, purely to satisfy Mastra's type. Deleted. |
| `ValidationError` carrier / `isValidationError` | `tool-model-output.ts:204,216` | no producer once `createTool` is gone. Must be replaced by validating **once**, in the host, not simply dropped. |
| `ToolPayloadTransform*` types | **nobody on the host path.** Written by `hook-tool-wrap.ts:242` and `tool-output-artifact-settlement.ts:100`; read only by Mastra's loop. | local type declarations, or deleted with their writers. |

### The writer is the easy part, not the hard part

`ToolStream.custom` in full (`@mastra/core/dist/stream--7NrsmVY.js:57-59`):

```js
async custom(data) {
    if (this.writeFn) await this.writeFn(data);
}
```

The host already constructs the `ToolStream` and already supplies `writeFn`
(`canonical-context.ts:34-38`, wrapping `HostToolContext.write`). The consumer
side already declares the writer structurally
(`tool-execute-support.ts:157`: `writer?: { custom: StreamWriterLike }`) and
`agent/src/mastra/shell-output-stream.ts:16` declares `ShellOutputWriter` locally
with no Mastra type. So the answer to "who supplies the writer once Mastra's tool
runtime is gone" is: **the host already does.** It would construct
`{ custom: (chunk) => context.write(chunk) }` instead of `new ToolStream(…)`,
which is behaviourally identical for `.custom`.

Two details worth keeping:

- `ToolStream.write()` wraps the chunk in a `${prefix}-output` envelope.
  `shell-output-stream.ts:8-12` documents that the shell path deliberately uses
  `.custom` to *avoid* that envelope. Nothing on the host path calls `.write()`.
- `tool-execute-support.ts:171` currently accepts **two** writer shapes
  (`writer.custom` or a bare `outputWriter`) and two tool-call-id positions
  (`agent.toolCallId` or `toolCallId`). Both tolerances exist because Mastra
  passes one shape to `createTool` instances and another to plain objects. A
  host-owned representation collapses each to one.

---

## 6. Residual `@mastra/core` after a tool-representation change

Measured by walking imports from the public entries the host consumes.

### `agent-host`, outside the memory adapters

| File | Imports |
| --- | --- |
| `adapters/canonical-context.ts` | `RequestContext`, `PublicSchema`+`toStandardSchema`, `noopObserve`+`ToolExecutionContext`+`ToolStream` |
| `adapters/host-tool-discovery.ts` | `MastraDBMessage` (type), `StandardSchemaWithJSON` (type), `createTool`+`ToolExecutionContext` |
| `model-router-sdk.ts` | `ModelRouterLanguageModel` (`@mastra/core/llm`) — provider routing |
| `provider-schema-selection.ts` | `StandardSchemaWithJSON` (type only; its values already come from `@mastra/schema-compat`) |

Everything else (11 further files) is `@mastra/memory` and its storage/vector/
`MessageList` adapters, which ADR-0012 keeps.

### `packages/agent`, reachable from `tool-runtime` and `mcp-client`

19 `@mastra/core` import sites across 11 files from `tool-runtime` alone. The
ones a tool-representation change does **not** reach:

| Concern | Site |
| --- | --- |
| Hosted tool discovery | `mastra/tool-search-runtime.ts` (753 lines) constructs `new ToolSearchProcessor({ tools: deferredTools as Record<string, Tool> })` and uses `MessageList`, `MastraDBMessage`, `RequestContext`, `MASTRA_THREAD_ID_KEY`. `agent-host/src/adapters/host-tool-discovery.ts` calls `createTool` purely to feed it. |
| Skills | `skills/skill-tools.ts` (`createSkillTools`, `WorkspaceSkills`), `index.ts:84` (`formatSkillActivation`), `tool-runtime.ts:3` (`formatSkillsCatalog`), `skills/scanned-workspace-skills.ts` |
| Provider request shaping | `provider-request.ts` (`TripWire`, `Processor`, `TokenLimiter`), `providers/foreign-provider-history.ts` (`ProviderHistoryCompat`), `providers/canonical-provider-limiter.ts`, `providers/openrouter-strict-content.ts`, `providers/provider-factory.ts`, `providers/listing-only-model.ts` |
| Background tasks | `background-result-projection.ts` |
| Memory | all of `pglite-mastra-memory/` |

**`@mastra/core` is a direct dependency of exactly three packages:**
`packages/agent`, `packages/agent-host`, `packages/test-utils`.
`packages/host-capabilities` has none.

---

## 7. A correction to ADR-0022's step-4 file list

`docs/archive/web-assistant-engine-scoping-2026-10-15.md` computed the
tool-projection cluster by seeding from ten named projection modules and taking
their closure. Reproducing that seed gives **16 files / 4,967 lines** — matching
the doc's 16 / 4,983 to within a line-counting difference, which confirms the
method.

But that seed does not include the two *public entries the host actually
imports*. Walking from `packages/agent/src/tool-runtime.ts` and
`packages/agent/src/mcp-client.ts` reaches **21** `src/mastra/` files, nine of
which are outside the seeded cluster:

| Lines | File | Reached via |
| ---: | --- | --- |
| 753 | `default-instructions.ts` | `tool-runtime` → `buildDefaultInstructions` and four siblings |
| 753 | `tool-search-runtime.ts` | `tool-runtime` → `BrainstrikeToolSearchProcessor`, `resolveToolDiscoverySurface`, `createPersistedStepArgs`, `resolveHostedToolDiscoveryAdapter` |
| 445 | `mcp-tool-loader.ts` | `mcp-client` → `collectCombinedTools` |
| 148 | `plan-mode-tool-gate.ts` | `tool-runtime` → `filterToolsForPlanMode` |
| 137 | `stream-run-event-chunks.ts` | closure |
| 123 | `mcp-discovery-diagnostics.ts` | `mcp-client` → `McpDiscoverySkip` |
| 112 | `deferred-tool-catalog.ts` | `tool-runtime` → `LIST_AVAILABLE_TOOLS_ID` |
| 45 | `mastra-agent-error.ts` | closure |
| 34 | `deferred-capability-families.ts` | closure |

Every one of those entry symbols has at least one consumer outside
`packages/agent` (`collectCombinedTools`: seven files).

The root `.` entry adds no further `src/mastra/` modules beyond the seeded
cluster: the host's 104 root imports resolve to nine `./mastra/*` modules
(`grep-model-format`, `mcp-task-tool-result`, `permission-policy-request`,
`permission-tool-gate`, `shell-output-stream`, `tool-call-telemetry`,
`tool-model-output`, `tool-output-artifact-reader`,
`tool-projection-input-rejected`), all already inside the 16.

| Set | Files | Lines |
| --- | ---: | ---: |
| `src/mastra/` non-test, total | 100 | 32,847 |
| Seeded tool-projection cluster (reproduces the scoping doc) | 16 | 4,967 |
| Union with the `tool-runtime` + `mcp-client` entry closures | **25** | **7,517** |
| Retirable on that union | **75** | **25,330** |

This does not change ADR-0022's decision — web still stops calling the loop and
the deletion is still the largest subtraction available. It changes **which
files step 4 may delete**. The 82/83-file list would remove nine modules that
two surviving public entries export.

---

## 8. What was not verified

- **Nothing was executed.** Every claim above is read from source, from the
  installed `dist` of the vendor packages, or from a static import walk. No test
  was run and no behaviour was exercised.
- **The import walk resolves relative specifiers only** (`.ts`, `.tsx`,
  `/index.ts`, `.js` → `.ts`), statically and for literal `import()`. A module
  reached only through a computed specifier or a package self-reference would be
  missed.
- **Whether Ajv's draft-07 engine resolves `#/$defs/...` pointers identically to
  the 2020-12 engine** was not tested. It matters only for an MCP server that
  uses `$defs` without declaring `$schema`, which `JsonSchemaWrapper` then stamps
  as draft-07.
- **`appCapable`'s future home** depends on whether the host grows its own MCP
  Apps admission. Today it has none; that is a statement about the present, not
  a prediction.
- **Whether any MCP server in use actually ships 2020-12 composition** was not
  measured. The preservation claim is about the code path, not about observed
  traffic.
