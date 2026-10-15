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
| `mcpMetadata` (`{serverName, appCapable}`) | only `agent/src/mastra/mcp-app-tool-call.ts`, whose sole callers are `agent-runtime.ts:79` and `runtime-assembly/tool-pipeline.ts:52` — both engine. | server identity is already `HostTool.mcpBinding {configuredServerId, generation}` + `mcpAuthority`. `appCapable` is **deleted** — see §5a: the host's own Apps admission gates on mount evidence, not on capability metadata. |
| `writer` (progress streaming) | `host-capabilities/src/native-tools/tool-execute-support.ts:171` | the host already supplies the sink. See below. |
| `ToolExecutionContext` slice (`agent`/`writer`/`abortSignal`) | `mcp-runtime-client.ts:403` | `HostToolContext` (`ports.ts:137`), which is already richer and already the thing `createCanonicalToolContext` converts *from*. |
| `requestContext` / `parseMemoryRequestContext` | `agent/src/tools/read-tool-call-id.ts:46` | unreachable on the host path: `readExecutionIdentity` finds the top-level `threadId` that `createCanonicalToolContext` sets, and returns before the `RequestContext` branch. The host constructs `new RequestContext()` empty, purely to satisfy Mastra's type. Deleted. |
| `ValidationError` carrier / `isValidationError` | `tool-model-output.ts:204,216` | no producer once `createTool` is gone. Must be replaced by validating **once**, in the host, not simply dropped. |
| `ToolPayloadTransform*` types | **nobody on the host path.** Written by `hook-tool-wrap.ts:242` and `tool-output-artifact-settlement.ts:100`; read only by Mastra's loop. | local type declarations, or deleted with their writers. |

### 5a. The host already has an MCP Apps admission — a different one

Flagged in review on PR #3646, and correct: `packages/agent-host/src/mcp-app-calls.ts`
implements host-owned `mcp/app/admit` and `mcp/app/call`. So "when a host-side
MCP Apps admission exists" was the wrong framing. The two admissions differ in
what they gate on:

| | Engine (`mastra/mcp-app-tool-call.ts`) | Host (`agent-host/src/mcp-app-calls.ts`) |
| --- | --- | --- |
| Granularity | per run | per call |
| Evidence | `mcpMetadata.appCapable` tallied across registered tools; `agent-runtime.ts:599` skips the Apps machinery when `appCapableToolCount === 0` | a committed `effect.finished` row of that thread mounted this exact app — `serverId`/`toolName`/`resourceUri`/`mimeType` all matching (`decideHostMcpAppCall`, `sameApp`) |
| Then | registers the Apps run | root thread's live policy + grants (`hostPolicyDecision(…, 'mcp', …)`), then `mcp.callAppTool` |
| Reads capability metadata | yes | **no** |

Mount evidence is strictly stronger than a capability declaration: a tool that
advertised Apps capability but never mounted an app still cannot call, and a
tool that did mount one is admitted whatever it advertised. The host therefore
needs no per-run registration gate, and `appCapable` can be deleted outright
rather than held as an open item. Confirmed by grep: no occurrence of
`appCapable` or `mcpMetadata` anywhere in `packages/agent-host` or
`packages/host-capabilities`.

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

## 7. ADR-0022's step-4 file count, and why it should not exist

`docs/archive/web-assistant-engine-scoping-2026-10-15.md` computed the
tool-projection cluster by seeding from ten named projection modules and taking
their closure. Reproducing that seed gives **16 files / 4,967 lines** — matching
the doc's 16 / 4,983 to within a line-counting difference, which confirms the
method.

The seed is what was incomplete, and it has been incomplete four times. Each row
below was measured with the same walk, widening only the seed:

| # | Seed | What it counted | Survivors | Retirable |
| ---: | --- | --- | ---: | ---: |
| 1 | Tool-projection module names (the scoping doc) | ten hand-listed filenames + closure | 16 | 83 |
| 2 | `closure(tool-runtime ∪ mcp-client)` | two published entries | 21 | 79 |
| 3 | + direct-consumer accounting | entries + outside importers | 25 | 75 |
| 4 | + every other surviving `package.json` export | **all** published entries | 31 | 69 |
| 5 | + outside consumers, e2e counted as test | the agreed set | **34** | **66** |
| — | the same, read literally (e2e counted as production) | what the rule's clause exists to prevent | 73 | 27 |
| 6 | row 5 with `shell-output-stream` split | engine half of the module dropped | 33 | 67 |

**Every revision from 1 to 5 had one cause: an incomplete seed.** First a list of
filenames rather than entries (1→2); then two published entries still missing,
`./provider-request` and `./provider-runtime` (3→4); then a consumer filter that
excluded `__tests__` and `*.spec.*` but not `e2e/` (4→5). None of the revisions
came from the tree changing. The unnumbered row is not a step in the sequence —
it is the outcome of reading "non-test consumer" literally, and the reason the
rule names e2e helpers.

### What the entry-only closure adds over the seeded cluster

Walking from `tool-runtime.ts` and `mcp-client.ts` adds nine modules, each with
at least one consumer outside `packages/agent`:

| Lines | File | Reached via |
| ---: | --- | --- |
| 753 | `default-instructions.ts` | `buildDefaultInstructions` and four siblings |
| 753 | `tool-search-runtime.ts` | `BrainstrikeToolSearchProcessor`, `resolveToolDiscoverySurface`, `createPersistedStepArgs`, `resolveHostedToolDiscoveryAdapter` |
| 445 | `mcp-tool-loader.ts` | `collectCombinedTools` (seven consumer files) |
| 148 | `plan-mode-tool-gate.ts` | `filterToolsForPlanMode` |
| 137 | `stream-run-event-chunks.ts` | closure |
| 123 | `mcp-discovery-diagnostics.ts` | `McpDiscoverySkip` |
| 112 | `deferred-tool-catalog.ts` | `LIST_AVAILABLE_TOOLS_ID` |
| 45 | `mastra-agent-error.ts` | closure |
| 34 | `deferred-capability-families.ts` | closure |

Widening to **every** surviving `package.json` export adds thirteen more,
reached over **runtime (value)** edges, not type edges. This set was found by
`delete-the-orphaned-mastra-agent-loop` and reproduced here independently:

| Entry | Modules |
| --- | --- |
| `./provider-request` | `error-processors` (239), `projection-safe-tool-call-filter` (753), `token-measurement` (661), `tool-projection-rewrite-processor` (73), `openai-tool-search-history-compat` (220), `openai-duplicate-item-compat` (338), `bedrock-message-hygiene` (245), `mastra-agent-error` (45), `tool-call-telemetry` (48) |
| `./provider-runtime` | `mastra-chunk-decoding` (734), `runtime-configuration` (137), `runtime-assembly/usage-metering` (263) |

Verified as value edges by reading the entry files: `provider-request.ts:22-32`
is seven plain `import { … }` statements and `provider-runtime.ts:15-23` is
three `export { … } from`. Deleting any of them breaks a published entry.

The table above lists the **12** modules reached by a runtime edge. A
thirteenth, `permission-policy-request`, is reached type-only and erases at
build — an earlier revision of this document said "13 … through runtime
imports", which conflated the two.

**Correction (PR #3653):** that revision also called four of them "Mastra
`Processor` implementations" — `error-processors`,
`projection-safe-tool-call-filter`, `token-measurement`,
`tool-projection-rewrite-processor` — and got two wrong in opposite directions.
Grepping each of the 13 for an `@mastra/core/processors` import gives **six**:
`error-processors`, `tool-projection-rewrite-processor`,
`projection-safe-tool-call-filter`, `openai-tool-search-history-compat`,
`openai-duplicate-item-compat` and `bedrock-message-hygiene`.
`token-measurement` is **not** one — it imports `ToolsInput` from
`@mastra/core/agent` and `toStandardSchema`/`standardSchemaToJSONSchema` from
`@mastra/core/schema`, and nothing from `@mastra/core/processors`.
`error-processors` is the strongest case and went unremarked: it instantiates
Mastra's own `PrefillErrorHandler`, `ProviderHistoryCompat` and
`StreamErrorRetryProcessor`.

The wrong four were inferred from module names instead of grepping the imports
— the same class of error as the incomplete seed sets behind 83, 79, 75 and 69,
committed in the same document that catalogues them. Verified here by
`git grep -l "@mastra/core/processors"`, which after ADR-0022's step 2 finds all
six under their relocated path `packages/agent/src/mastra-processors/`.

### The last row is one file, and it is a decision

`apps/desktop/e2e/helpers/mcp-apps-ordinary-admission.ts` is the **only**
consumer outside `packages/agent` of both `composeRuntimeToolMap`
(`index.ts:266` → `mastra/runtime-assembly/tool-pipeline.ts:503`) and
`createMcpAppOrdinaryToolCallPreparer` (`index.ts:249` →
`mastra/mcp-app-tool-call.ts:291`). Counting it as a consumer pulls in 38
further modules and takes the deletion from 66 files to 27.

It is an e2e **helper**: test support that lives outside `__tests__` and is not
named `*.spec.ts`, so a literal "non-test consumer outside `packages/agent`"
filter counts it. Whether it is re-pointed or deleted alongside the nine desktop
tests step 3 already re-points is a decision, not a measurement — and the rule
below has to say which, or two readers will compute two answers.

### Independent convergence, and two further files

`delete-the-orphaned-mastra-agent-loop` re-ran its own walk after the e2e-helper
clause, from a differently-seeded walk (union of `closure(surviving public
entries)` and `closure(the 21 production-consumed files)`). Re-running the walk
here with `mcp-app-tool-call.ts` excluded — its only consumer outside
`packages/agent` being that same e2e helper — lands on the same place:

**34 survivors / 10,839 lines, 66 retirable / 22,008 lines.**

The **65** an earlier revision of this document reported was one file high: it
kept `mcp-app-tool-call.ts`. 66 is the figure to quote.

### The counting convention is `wc -l`, and it is a trap

The two walks first disagreed on line counts — 10,873 / 22,074 against 10,839 /
22,008 — and that was not a rounding difference. `split('\n').length` counts the
empty string after a file's trailing newline, so it returns exactly one line too
many **per file**: across these 100 files it gives 32,947 where `wc -l` gives
32,847, a delta of exactly 100.

ADR-0022's own "100 files / 32,847 lines" is `wc -l`, so that is the project's
convention and the inflated pair was wrong.

**The check that catches this: survivors + retirable must equal the directory
total.** 10,839 + 22,008 = 32,847 ✓. 10,873 + 22,074 = 32,947 ✗ — and it
contradicts the 32,847 sitting in the same paragraph. Any recomputation under
the rule should be reconciled that way before it is written down. Noted here
because whoever measures next will reach for `split('\n')`.

Two independently seeded walks landing on the same file count is stronger
evidence than either alone — and it is still a dated measurement, not a
commitment.

Its re-scan found its own filter had excluded `__tests__` and `*.spec.*` but not
`e2e`, `qualification` or fixtures, which is why two test-only consumers had been
reported as production. With e2e counted as test, three files are test-adjacent
only: `runtime-assembly/tool-pipeline.ts` and `mcp-app-tool-call.ts` via
`apps/desktop/e2e/helpers/mcp-apps-ordinary-admission.ts` (which carries four
`@boundaries-ignore` comments stating it deliberately composes the production
pipeline), and `agent-runtime.ts` via
`apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`.

It also reported a refinement that touches this document's §5 directly:
`tool-event-mapper.ts` (348 lines) is in the survivor closure **only** because
`shell-output-stream.ts` imports `readMastraStreamPartString` for
`mapShellOutputStreamPart`, whose sole caller is `agent-streaming.ts:748` — the
engine. Nothing outside `src/mastra/` imports `tool-event-mapper` at all. So
`shell-output-stream.ts` splits: `writeShellOutputChunk` (what
`host-capabilities` imports, with its locally declared `ShellOutputWriter`) stays
and `mapShellOutputStreamPart` goes with the engine, dropping a further module
to 33 survivors / 67 retirable and keeping a Mastra stream-part reader out of
`src/tool-projection/`. That split is consistent with §5's finding that the host
side of the writer path carries no vendor type.

### The rule

> Delete every `src/mastra/` module that no surviving `package.json` export
> entry reaches and no non-test consumer outside `packages/agent` imports —
> where e2e helpers count as tests and are re-pointed, not preserved —
> recomputed immediately before the deletion lands.

Current sizing, **as sizing and not as an ADR commitment**: 66 retirable / 34
surviving with that helper re-pointed; 27 / 73 without; 67 / 33 if
`shell-output-stream.ts` is also split.

None of this changes ADR-0022's decision. It changes what step 4 must establish
before it deletes anything.

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
