# Effect Schema migration order

[ADR-0004](../adr/0004-effect-at-runtime-boundaries.md), amended 2026-10-15,
makes Effect Schema the single boundary owner. Native tool inputs and the host
wire now use Effect. The sections below record the remaining boundaries and
the acceptance rules their conversions must preserve.

Counts are exported `*Schema` constants in non-test source, measured at
`58689c3fa`. Sizes are a review-cost signal, not a schedule. The catalog is on
`effect` 4.0.5 GA; every API the derivation uses is tagged `@stability stable`.

## The rule each PR follows

Author in Effect Schema; register a tool with `effectToolInputSchema`; read a
registered schema through `toToolInputJsonSchema` / `validateToolInputValue`.
One producer per schema — never a second writer for the same durable fact. A
converted boundary keeps the acceptance check its zod version had.

## String length bounds

On the current Zod 4.6.7 pin, `.min()` and `.max()` count Unicode code
points, matching JSON Schema. Convert string bounds with
`Schema.isMinCodePoints(min)` and `Schema.isMaxCodePoints(max)` to preserve
that acceptance. Arrays still use `isMinLength` / `isMaxLength`.

Earlier conversions used `isMaxLength` to preserve the older Zod UTF-16
behavior. Those declarations retain their existing contract; do not copy that
rule into a new conversion without checking the installed source. E01 pins
astral-string acceptance at both ends of the current string bounds.

## Order

### 1. The remaining native tool schemas — 30 tools, 9 files, 48 constants

`packages/assistant-contract/src/native-tools/schemas/` owns all native tool inputs.
Every catalog entry now uses one Effect grammar. Strict provider inputs use
`effectToolInputSchema`; Mastra skill inputs retain their existing open/strip
policy through `standardInputSchema`. Execution and permissions stay with their
existing owners.

| file | status / contract |
| --- | --- |
| `schemas-browser.ts` | Done; defaults advertise and fill synchronously |
| `schemas-diagnostics.ts` | Done |
| `schemas-tasks.ts` | Inputs and ordinary open/strip resume decoders done |
| `exec-policy-domain.ts` | Done with the execution/policy composition sites |
| `schemas-search.ts` | Done; code-point bounds, finite weights and issue paths |
| `schemas-artifacts.ts` | Done; internal reader shares cursor/page grammar |
| `schemas-execution.ts` | Done; semantic action-union exclusivity retained |
| `schemas-workspace.ts` | Done; cursor/path exclusivity, action-branch stripping and UTF-8 canvas ceiling |

`skill`, `skill_read`, and `skill_search` now derive from Effect while preserving
Mastra's stripping acceptance policy and closed provider advertisement. The ordinary
boundary names those two policies explicitly; resume envelopes advertise open
objects. `runPython` is wrapped at its declaration so
its direct parsing and registered schema share provider-null normalization;
registering it unwrapped in the definition is intentional. Python's network
suspend/resume decoders stay strict and do not normalize null consent riders.

### `exec-policy-domain.ts` could not convert on its own (done)

`policyDomainSchema` is not a registered tool input schema, so
`effectToolInputSchema` does not apply to it. It is a shared LEAF, composed by
two zod owners:

- `schemas-execution.ts` builds `runPythonDomainSchema` as
  `policyDomainSchema.refine(…).refine(…)`, and
- `packages/agent/src/code-execution.ts` puts it in
  `z.array(policyDomainSchema)` inside `execPolicySchema`, the authoritative
  sandbox policy parser.

Converting the leaf while either composition site is zod needs a zod twin of
the domain grammar — a second writer for a safety-critical invariant (an empty
`allowedDomains` meaning "no network"). So it converts WITH
`schemas-execution.ts`, and `execPolicySchema` moves in the same change or
immediately after. Treat the table row as part of that file, not before it.

### Annotate BEFORE a custom filter

effect 4.0.4 DROPS a schema-level annotation applied after a custom
`Schema.makeFilter`. `Schema.String.check(isMinCodePoints(1), isMaxLength(10))
.annotate({ description })` emits the description; add any `makeFilter` to that
`.check()` — or chain a second `.check(makeFilter(…))` before annotating — and
the description never reaches the document. Built-in checks are unaffected,
which is why `schemas-worktrees.ts` and the three files before this one never
showed it.

The order that works is `Schema.String.annotate({ description }).check(…)`.
A consequence: a single shared constant carrying a custom filter cannot also
carry a per-use-site description, so share the FILTER and let a small helper
compose it with the description — `rootRelativePath` in `schemas-execution.ts`
is the worked example, serving `runSkillScript`'s `cwd` and `scriptPath`.

`Schema.makeFilterGroup` is NOT the way out: it emits `allOf`, which the
catalog spec's provider-shape sweep rejects outright.

### A union's advertised keyword, and its discriminant

`z.discriminatedUnion` emits `oneOf`; `Schema.Union` defaults to `anyOf` and
takes `{ mode: 'oneOf' }`. Pass the mode — it is what makes the DECODER require
exactly one matching member, so a later overlapping branch fails rather than
silently taking the first match.

The advertised keyword still lowers to `anyOf` whenever any union member
carries `Schema.isMaxLength`, which in practice means most of them. Bisected
check by check on 4.0.4: `isMinLength`, `isMinCodePoints` and the numeric
bounds all keep `oneOf`. Treat the lowering as expected, not as a conversion
mistake, and do NOT reach for `isMaxCodePoints` to dodge it — that validates
more loosely than the zod bound did, trading a real check for a keyword.

The lowering is the safe direction: OpenAI's structured-output dialect accepts
`anyOf` and rejects `oneOf`. `normalizeProviderNulls` reads either keyword, and
either discriminant spelling — Effect emits a discriminant as a one-element
`enum: ['start']` where zod emitted `const: 'start'`. Both deviations are why a
union's zod twin in `effect-authored-zod-twins.ts` is written with `z.union`
and `z.enum(['start'])` rather than the zod it replaced.

Not covered by any guard today: the `mode` itself. Mutating `'oneOf'` to
`'anyOf'` changes no advertised document and no current decode, because every
branch is picked by a distinct literal. It is a declaration for the next
branch, so keep it.

### `Schema.isPattern` needs the Unicode flag to advertise

zod's `.regex()` always emits `pattern`. `Schema.isPattern` emits it only when
the RegExp carries `u` and its other flags are limited to `d`, `g` or `y`. So a
faithful conversion of a `.regex()` bound adds `u` (`runSkillScript`'s
`skillName`). A case-insensitive pattern cannot advertise at all, which is fine
where the zod original was a `.refine()` — `exec-policy-domain.ts`'s
`DOMAIN_PATTERN` is `makeFilter` for exactly that reason, and because each of
its four rules keeps its own message.

### Resume schemas retain their existing acceptance policy

`SubmitPlanResumeSchema` and `AskUserResumeSchema` use ordinary Effect decoders
through `standardInputSchema`. Unknown envelope riders are stripped. AskUser
keeps its current envelope and bare string/string-array arms; its declared
`approved` rider must still be `true` when present. These are receiving
boundaries, outside the strict provider input producer. The SDK requires both
Standard Schema validation and JSON Schema, plus its required inference phantom;
that interface does not require a second production Zod grammar.

### zod `.default()` is two facts, not one

zod's `.default(v)` both advertises `default: v` in the emitted JSON Schema and
fills an absent key on parse. Effect spells those separately, and the browser
tools need both — `runBrowserReadPage` hands `maxChars` straight to
`accessibility-snapshot`, where an unfilled value makes its
`used + cost > options.maxChars` budget check compare against `undefined` and
the output cap silently stop applying. The pair is
`schema.annotate({ default: v }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(v)))`,
taking the literal once (`withDefault` in `schemas-browser.ts`). Three traps:

- For provider JSON inputs, `withDecodingDefaultKey` fills an absent key;
  JSON cannot carry an own `undefined`. The value-level twin also treats an
  explicit `undefined` as absent and changes the advertised property shape.
  Ordinary host wire defaults use that value-level behavior to match Zod.
- It takes an `Effect`, not a thunk. A bare `() => v` compiles and fails at
  runtime with `Fiber.runLoop: Not a valid effect`.
- `.annotate()` must come BEFORE the `.pipe(…)`, or the emitter never sees the
  `default`.

Dropping the fill while keeping the annotation is invisible to a JSON Schema
equivalence test — the advertised document is identical. The catalog's
`accepts provider null for optional fields` case is what catches it.

The native Zod producer and Zod branches of `NativeToolInputSchema`,
`toToolInputJsonSchema`, and `validateToolInputValue` are retired. Preconversion
Zod twins remain test-only provider/acceptance oracles. External host/MCP/vendor
schemas still use their owning adapters and the shared neutral
`normalizeProviderNulls`; this is not repository-wide Zod removal.

An empty object uses `Schema.Record(Schema.String, Schema.Never)`.
`Schema.Struct({})` means any non-nullish value in Effect 4.0.5, so it would both
accept primitives and fail to advertise an object for `listWorkspaceContext`.
The derived provider view includes an explicit empty `properties` map, preserving
the prior no-argument tool wire shape. An unconstrained nullable read-file root
uses Effect’s equivalent `anyOf` spelling instead of Zod’s type array; the provider
fixture pins both spellings and compares all remaining facets unchanged.

Two downstream shapes change with each file and are worth expecting rather
than discovering:

- **`Schema.Array` decodes to a `readonly` array**, where `z.array` did not. A
  consumer typed `string[]` stops compiling; the fix is to accept
  `readonly string[]` where it only reads (as `shouldCheck` in
  `packages/agent/src/tools/diagnostics-tool.ts` now does).
- **A Mastra `createTool` infers its `execute` input through
  `InferPublicSchema`**, which tries `_output`, then `_type`, then a REQUIRED
  `'~standard'.types`. zod reaches the first branch via its private `_output`;
  the Effect producer has neither, so `EffectToolInputSchema` declares the
  Standard Schema `types` phantom as required (declared, never constructed —
  zod's own `standardProps()` does the same). Without it every
  Effect-authored tool's `execute` sees `unknown`. Only `askUser` and
  `submitPlan` go through `createTool` today; the hand-rolled "Mastra tool"
  interfaces elsewhere in `packages/agent/src/tools` are structural
  (`inputSchema: typeof XSchema`) and need nothing.

### 2. `packages/host-capabilities` — 4 constants, 5 files

Small, and it consumes the tool boundary rather than defining much of it. Doing
it here keeps the executor side on one library before the protocol work starts.

### 3. `packages/agent` — 9 constants, 21 files

Mostly re-export surfaces over `assistant-contract` (`src/tools/schemas-*.ts`)
plus `validateToolInput`, already producer-neutral. Expect deletions.

### 4. `packages/mcp-tasks-extension` — 27 constants, 3 files

Dense but self-contained. These are MCP wire shapes, so they must stay faithful
to the negotiated revision — convert against
[MCP conformance](mcp-conformance.md) and re-run `pnpm verify:mcp`.

### 5. `apps/desktop` — 108 constants, 38 files

Split by domain, never as one PR. **The 26 `src/ipc-domains/*.contract.ts`
files are the hard constraint**: ADR-0004 says a contract module cannot import
`effect`, because preloads reach every `*.contract.ts` and the preload import
graph rejects bare packages. So either the contracts keep their pure parser
surface and only the main-side handlers decode with Schema (ADR-0004's existing
Phase 2 position), or that constraint is revisited on its own — which is a
decision, not a conversion. Do the non-contract desktop schemas first and leave
the IPC seam until that is answered.

## Host wire adoption

The host protocol's first-party grammars and their composition consumers use
Effect Schema. JSON-RPC version 11, method names, IDs, admission, persistence,
cryptographic snapshot checks and shutdown owners retain their existing contracts.
This conversion does not introduce an RPC engine or an Effect run loop.

Shared workspace, boundary-failure and MCP DTO leaves move with the host schemas.
Desktop admission composes those leaves, so its platform/configuration/retrieval
schemas and the subagent-settings leaf move in the same change. Other desktop,
agent, host-capability and MCP extension boundaries remain separate waves.

Decode with the receiving boundary's established excess-property policy. Ordinary
wire optionals retain an own `undefined`; only fields whose existing normalizer
omits it use `omitUndefinedOptional`. Ordinary Zod defaults accept absent and
explicit `undefined`, matched by `withDecodingDefault`; the provider JSON-only
key-default rule above is a separate boundary. Empty strict objects use
`Schema.Record(Schema.String, Schema.Never)`.

Retrieval results strip unknown fields while their nested prompt objects remain
strict. `strictWireSchema` delegates to the same authored grammar with that nested
policy, preserving its result and Effect issues. SDK-owned MCP schemas remain the
vendor authority through `sdkSchema`; the adapter returns the SDK's validated
value. Date-time filters use the pinned vendor's format pattern, and MCP URL
normalization preserves trimming and removal of ASCII tabs/newlines. No second
production grammar or schema-shape assertion supplies those values.

An `effect/rpc` or service/runtime ownership change still needs a separate owner
decision. The allowed imports remain exactly `effect` and `effect/testing`;
stability checks apply to each selected API on the installed pin. Preload value
imports remain outside the Effect graph.
