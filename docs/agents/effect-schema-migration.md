# Effect Schema migration order

[ADR-0004](../adr/0004-effect-at-runtime-boundaries.md), amended 2026-10-15,
makes Effect Schema the single boundary owner. The derivation step for LLM tool
definitions is built and proven, and `listWorktrees` / `manageWorktree` are
converted. This is the order for the rest.

Counts are exported `*Schema` constants in non-test source, measured at
`58689c3fa`. Sizes are a review-cost signal, not a schedule. The catalog is on
`effect` 4.0.4 GA; every API the derivation uses is tagged `@stability stable`.

## The rule each PR follows

Author in Effect Schema; register a tool with `effectToolInputSchema`; read a
registered schema through `toToolInputJsonSchema` / `validateToolInputValue`.
One producer per schema — never a second writer for the same durable fact. A
converted boundary keeps the acceptance check its zod version had.

## String length bounds

`Schema.isMinLength(n)` emits `minLength: Math.ceil(n / 2)`, not `n`:
JavaScript counts UTF-16 code units and JSON Schema counts code points, so
Effect advertises the tightest bound that cannot reject a string the check
accepts. Sound, but it advertises half the real minimum, and a provider
enforcing the advertised schema then accepts a value the host rejects — the
error surfaces one hop later than it should.

So a converted string bound is `Schema.isMinCodePoints(min)` plus
`Schema.isMaxLength(max)`:

- `isMinCodePoints(n)` emits `minLength: n` exactly.
- `isMaxLength(n)` emits `maxLength: n` exactly AND keeps zod's code-unit
  counting; `isMaxCodePoints` would accept a long run of surrogate pairs that
  the zod version rejected.

Arrays are unaffected — `isMinLength` emits `minItems` exactly for them, and
`isMinCodePoints` does not typecheck on an array.

`isMinLength(1)` emits `1`, so this is invisible until a bound exceeds 1.
`schemas-worktrees.ts` is all `min(1)` and needs no change; the gap first
appeared on `queryDiagnostics`'s `since` / `until` (`min(20)`).

## Order

### 1. The remaining native tool schemas — 30 tools, 9 files, 48 constants

`packages/assistant-contract/src/native-tools/schemas/`. The bridge is in, so
each file is now a local change: convert the declarations, point the
definitions at `effectToolInputSchema`, and the display, validation and
provider paths follow without edits.

| file | constants | what makes it work or not |
| --- | --- | --- |
| ~~`schemas-browser.ts`~~ | 3 | **done.** zod `.default()` is two facts — see below |
| ~~`schemas-diagnostics.ts`~~ | 6 | **done.** First file with a string `min` above 1; see "String length bounds" |
| ~~`schemas-tasks.ts`~~ | 3 of 5 | **inputs done.** The two resume schemas stay zod — see below |
| ~~`exec-policy-domain.ts`~~ | 1 | **done**, with the file below and the seam's `execPolicySchema` |
| `schemas-search.ts` | 9 | `.refine` only |
| `schemas-artifacts.ts` | 4 | `.refine` + `.superRefine` → `Schema.makeFilter`; see `schemas-worktrees.ts` for forwarding a nested union's issues with their paths |
| ~~`schemas-execution.ts`~~ | 5 | **done.** First converted action unions; see "A union's advertised keyword" and "Annotate before a custom filter" |
| `schemas-workspace.ts` | 14 | **the risky one.** Largest file (459 lines), a discriminated union, `.refine` and `.superRefine`, and `readWorkspaceFile`'s cursor-vs-path exclusivity. Convert it last and alone. |

Not wrapped by either producer today and needing a decision rather than a
conversion: `skill`, `skill_read`, `skill_search` declare `z.object` inline and
Mastra owns their execution (`defineNativeTool`'s `SkillNativeToolDefinition`
arm still accepts a bare `z.ZodType`); `runPython` registers an unwrapped
schema deliberately — check why before changing it. `askUser` and `submitPlan`
registered one too and now carry `effectToolInputSchema` at the declaration
instead, so their definitions still register the constant unwrapped.

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

### The two resume schemas stay zod

`SubmitPlanResumeSchema` and `AskUserResumeSchema` are not tool input schemas
and are deliberately unconverted:

- `effectToolInputSchema` fixes `onExcessProperty: 'error'`, so admitting a
  resume envelope through it would CLOSE an object zod leaves open to strip. An
  unknown rider on a person's answer would then strand a suspended run rather
  than being dropped.
- A resume envelope is never advertised to a provider — it travels host↔Core as
  the platform selection's `interaction.resumeSchema` — so the producer's
  pairing of a provider JSON Schema with a validator buys nothing.
- The catalog's one-producer guard sweeps `NATIVE_TOOL_INPUT_SCHEMAS`, which
  they are not in.

Converting them means either a second Effect producer with open-object
semantics or a ruling that the resume envelope should close. Both are owner
decisions. `apps/desktop/src/agent-host-platform/desktop-tool-descriptors.ts`
types `INTERACTIONS[].resumeSchema` as `z.ZodType` and would widen to
`unknown`, as its `inputSchema` already did.

### zod `.default()` is two facts, not one

zod's `.default(v)` both advertises `default: v` in the emitted JSON Schema and
fills an absent key on parse. Effect spells those separately, and the browser
tools need both — `runBrowserReadPage` hands `maxChars` straight to
`accessibility-snapshot`, where an unfilled value makes its
`used + cost > options.maxChars` budget check compare against `undefined` and
the output cap silently stop applying. The pair is
`schema.annotate({ default: v }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(v)))`,
taking the literal once (`withDefault` in `schemas-browser.ts`). Three traps:

- `withDecodingDefaultKey`, not `withDecodingDefault`. Only the key-level
  variant fills on an absent key alone, as zod did; the value-level twin also
  treats an explicit `undefined` as absent and emits an `anyOf: [T, null]`
  property, changing the advertised schema.
- It takes an `Effect`, not a thunk. A bare `() => v` compiles and fails at
  runtime with `Fiber.runLoop: Not a valid effect`.
- `.annotate()` must come BEFORE the `.pipe(…)`, or the emitter never sees the
  `default`.

Dropping the fill while keeping the annotation is invisible to a JSON Schema
equivalence test — the advertised document is identical. The catalog's
`accepts provider null for optional fields` case is what catches it.

Carry-over work once the last tool converts: delete
`providerCompatibleInputSchema`, drop the zod arm from
`toToolInputJsonSchema` / `validateToolInputValue`, collapse
`NativeToolInputSchema` to the Effect producer, and delete the
`registers every schema through exactly one producer` guard's zod branch.

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

## What has to move before `effect/rpc`

The ~60-method host protocol lives in `packages/agent-host`: 58 constants
across 42 files, with `src/protocol.ts` (1,074 lines) plus a 13-module
`protocol-*` / `*-wire` family (~1,160 lines). Putting it on a schema-derived
contract needs, in order:

1. **This PR.** Done: the derivation is proven and the tool boundary no longer
   forces zod. The question that blocked a schema-derived contract is answered.
2. **`packages/agent-host`'s own wire schemas converted** (step 2 above is the
   warm-up, not a prerequisite). The protocol modules are the contract — an RPC
   definition cannot be derived from schemas that are still zod. This is the
   real prerequisite and the largest single piece.
3. **An `effect/rpc` availability decision.** `rpc` ships inside the `effect`
   package in 4.0, so it is a root import rather than a separate dependency —
   but ADR-0004's import contract is an **allowlist** of exactly `effect` and
   `effect/testing`, so `effect/rpc` needs a contract change before a single
   line imports it. Stability is a separate axis: check the `@stability` tag on
   the `rpc` APIs the protocol would use, because an unstable one may break in a
   minor and an experimental one in a patch. The catalog is on `effect` 4.0.4 GA
   (#3628), so the version itself is no longer a blocker.
4. **A decision on the client side.** `packages/agent-host`'s protocol is
   consumed by `apps/desktop` main AND by the renderer through IPC. The
   preload constraint in step 5 above applies here too, so the protocol's
   schema ownership and the IPC seam have to be settled together rather than
   discovered halfway through.

Steps 1 and 2 are mechanical-plus-careful; 3 and 4 are owner decisions and
should be raised before the protocol PR is scoped, not during it.
