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

## Order

### 1. The remaining native tool schemas — 30 tools, 9 files, 48 constants

`packages/assistant-contract/src/native-tools/schemas/`. The bridge is in, so
each file is now a local change: convert the declarations, point the
definitions at `effectToolInputSchema`, and the display, validation and
provider paths follow without edits.

| file | constants | what makes it work or not |
| --- | --- | --- |
| `schemas-browser.ts` | 3 | mechanical |
| `schemas-diagnostics.ts` | 6 | mechanical |
| `schemas-tasks.ts` | 5 | mechanical; `submitPlan` / `askUser` also carry resume schemas and `askUser`'s is a union with a legacy arm |
| `exec-policy-domain.ts` | 1 | one `.refine` |
| `schemas-search.ts` | 9 | `.refine` only |
| `schemas-artifacts.ts` | 4 | `.refine` + `.superRefine` → `Schema.makeFilter`; see `schemas-worktrees.ts` for forwarding a nested union's issues with their paths |
| `schemas-execution.ts` | 5 | two `z.discriminatedUnion('action', …)` behind strict envelopes, same shape as the converted `manageWorktree` |
| `schemas-workspace.ts` | 14 | **the risky one.** Largest file (459 lines), a discriminated union, `.refine` and `.superRefine`, and `readWorkspaceFile`'s cursor-vs-path exclusivity. Convert it last and alone. |

Not wrapped by either producer today and needing a decision rather than a
conversion: `skill`, `skill_read`, `skill_search` declare `z.object` inline and
Mastra owns their execution (`defineNativeTool`'s `SkillNativeToolDefinition`
arm still accepts a bare `z.ZodType`); `askUser`, `submitPlan` and `runPython`
register an unwrapped schema deliberately — check why before changing them.

Carry-over work once the last tool converts: delete
`providerCompatibleInputSchema`, drop the zod arm from
`toToolInputJsonSchema` / `validateToolInputValue`, collapse
`NativeToolInputSchema` to the Effect producer, and delete the
`registers every schema through exactly one producer` guard's zod branch.

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
