# Native tool catalog ownership — evidence

Supports `docs/agents/assistant-providers.md` § "Context-window-scaled default budgets". The `defineNativeTool` declaration, derived registries, and the provider-`null` omission rule.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 4733-4828); append rather than
rewrite.

---

Native-tool catalog ownership (BST-1646): ONE `defineNativeTool` declaration
per tool, everything else derived.
- `packages/assistant-contract/src/native-tools/definitions/*.ts` — one file per
  tool declaring its id, model-facing description, registered Zod
  `inputSchema` (wrapped once in `providerCompatibleInputSchema`), load/risk
  `defaults`, `discovery` namespace + capability family, `surfaces`
  (desktop/web/local), history posture, non-durable output, and inspector
  `returns` prose. `native-tools/index.ts` is the ONLY list (`NATIVE_TOOLS`);
  `deriveNativeToolRegistries` produces every registry from it under its
  historical export name: `NATIVE_TOOL_ID`, the id partitions
  (`DESKTOP_/WEB_/LOCAL_DESKTOP_/SKILL_/NON_DURABLE_…`), `TOOL_DESCRIPTIONS`,
  `NATIVE_TOOL_DEFAULTS`, `NATIVE_TOOL_DISCOVERY_NAMESPACES` membership,
  `DEFERRED_CAPABILITY_FAMILIES`, the two history allowlists
  (`RECENCY_PRUNABLE_` / `STALE_REPLAYABLE_NATIVE_TOOL_IDS`), and the prompt
  composer's model-facing name map. `defineNativeTool` throws on an
  undeterminable risk bucket, a deferred tool without a namespace, or a
  critical tool with one. `NATIVE_TOOL_SCHEMAS` (the settings inspector
  display, and the built-in local model's tool schema via
  `toLocalRuntimeInputSchema`) is DERIVED from each definition's
  `inputSchema` by `native-tools/display.ts` (`toToolSchemaDisplay`, Zod 4
  `z.toJSONSchema` in `io: 'input'` mode — the same conversion the provider
  wrapper runs), so parameter names, types, required-ness, enum options,
  defaults, and bounds cannot drift from the wire. A parameter's prose is its
  `.describe()` text; a definition's `display` map adds inspector-only prose
  (never sent to the model) for a field whose wire description is absent or
  terser than a human reader needs, and a key naming no parameter throws at
  derivation. `NATIVE_TOOL_SCHEMAS` is NEVER an execution or provider-schema
  source.
- `packages/agent/src/tools/schemas.ts` exports `NATIVE_TOOL_INPUT_SCHEMAS`,
  derived from the desktop definitions' `inputSchema` objects (the Zod modules
  themselves live in `packages/assistant-contract/src/native-tools/schemas/`,
  exported as `@brainstrike/assistant-contract/native-tool-schemas`, and are
  re-exported from the historical `packages/agent/src/tools/schemas-*.ts`
  paths for one release — edit the contract package, never the agent shims). Desktop provider
  registration and `validateToolInput` reuse those same schema objects. Mastra
  converts them to provider JSON Schema through the Standard Schema input
  protocol; never reconstruct validation or provider schemas from the lossy
  display metadata.
- Agent Skills (`skill`/`skill_read`/`skill_search`) are `kind: 'skill'`
  definitions: Mastra executes them, but the provider contract Brainstrike
  imposes (`providerDescription` + `inputSchema` in `skill-tools.ts`) comes
  from the definition, and they are not entries in `NATIVE_TOOL_INPUT_SCHEMAS`.
  The separate desktop-only `brainstrike.runSkillScript` is a Brainstrike-owned
  typed execution tool and therefore is present in the desktop catalog/schema
  map, deferred `skills` namespace, and execute-risk policy; web and the
  built-in local model omit it.

Provider-emitted `null` has one fleet-wide meaning for the registered native
catalog: on an optional or defaulted field it is omission, never a second domain
value. `providerCompatibleInputSchema` in
`packages/assistant-contract/src/native-tools/schemas/provider-compatible-input.ts`
(re-exported by `packages/agent/src/tools/provider-compatible-input.ts`) wraps
each complete registered input once. One immutable traversal of its strict input JSON Schema
removes `null` only from declared properties absent from `required`, including
properties nested in arrays, tuple positions, uniquely const-matched
`oneOf`/`anyOf` branches, and unions with exactly one structured branch matching
the input's object/array kind. Dynamic record values (`additionalProperties`)
and ambiguous union branches are not omittable fields. Authored intersections
(`allOf`) and structured record values (an object-valued
`additionalProperties`) are intentionally unsupported traversal shapes for the
registered catalog. A catalog invariant converts every authored schema with the
same `{ cycles: 'throw', io: 'input', reused: 'inline' }` options and reports the
tool id plus JSON path if either unsupported shape appears. Boolean
`additionalProperties` values used by ordinary strict objects remain valid.
Input JSON Schema is derived lazily on the wrapper's first parse and memoized for
that wrapper. The paired exact-option catalog parity test eagerly converts every
registered wrapper before merge, so a future recursive or unrepresentable
schema fails in CI rather than first appearing in a live tool call. The authored
Zod schema then runs exactly once, applying ordinary optional/default behavior
before execution, while the wrapper leaves provider JSON Schema unchanged.
Required fields still reject `null`; invalid non-null values still fail their
original validators. Those failures stay observable through the ordinary
Mastra validation result or desktop `ToolInputValidationError`—there is no
coercion, retry, or fallback. Unknown `null` properties remain visible to strict
validation, while nested object-array properties follow the same omission rule.
An optional/defaulted catalog field must not use `null` as a meaningful
third-state such as "clear this value"; model that intent with an explicit action
or discriminator instead. Because provider `null` reaches the same path as
omission, omitted/default behavior must also be the least-capability behavior
and never more permissive than leaving the field unspecified.
The catalog's `ZodPreprocess`-constrained map makes the wrapper exhaustive for
newly registered schemas; server-owned MCP schemas and deprecated or otherwise
unregistered internal schemas are outside this native catalog rule.

Server-owned MCP schemas retain their own omission/null semantics. The MCP
adapter explicitly sets `strict: false` unless the server opts into strictness
through `_meta.mastra.strict`. An omitted strict flag lets OpenAI Responses
normalize optional fields into required ones: the 2026-09-04 Linear request
filled every filter, including `priority: 0`, and returned only no-priority
issues instead of the latest five issues. Do not repair that by stripping
zero, null, or empty arguments: those may be meaningful server inputs. Preserve
the schema and optional fields on the provider wire, with Mastra's original
JSON Schema validation still required before tools/call. The captured real
Mastra/OpenAI request in `mcp-optional-inputs.spec.ts` pins explicit non-strict
generation, required-field preservation, omission at execution, and continued
input validation; `mcp-runtime-client.spec.ts` pins explicit strict opt-in.
