# Approval reconstruction: prototype-carried runtime meaning

The independent d123f20 review found that the JSON-runtime predicate recognizes
an array prototype by its shape rather than its identity. A custom array
prototype can carry a process-local selection that JSON omits, while satisfying
the predicate. The initial exact example terminated before approval because the
SDK requires an array `map` primitive. Supplying that ordinary primitive on the
custom prototype reaches the real approval/reopen path: the isolated SQLite/SDK
regression executed once after the selection changed, when interruption and
zero effects were required. This is a demonstrated reconstruction defect, not
evidence about shipped native/MCP JSON schemas.

Evidence: `/tmp/brainstrike-m3-prototype-array-causal.log` (initial SDK failure)
and `/tmp/brainstrike-m3-prototype-array-runtime-repro.log` (actual approval,
reopen and unauthorized changed runtime meaning, 0.222 s test body). The new
default regression retains the actual transformed array and existing RAW input,
interaction, writer and runtime owner. No timeout, retry or test bypass changed.

This belongs to the input-reconstruction class already repaired in 53d074e,
3988804e and the Sean-authorized 17:45 existing-owner design. Root working rule 3
therefore requires another owner decision before changing the product predicate;
Studio has paused only that repair and continues Memory/UI composition.

Proposed disposition: preserve live SDK-validated inputs; on reopening accept
only local ordinary JSON record/array prototypes (or null-prototype records).
Reject custom and cross-realm prototypes unless the tool supplies the existing
explicit `reconstructApprovalInput` capability. Cross-realm ordinary records were
previously accepted by a shape heuristic; their required callers must be
identified before narrowing that behavior. A shape heuristic cannot establish
that inherited properties have no runtime meaning. No new message identity,
approval gate, history rewrite or transcript writer is proposed.

Owner decision: **AUTHORIZED** by Sean's explicitly assigned accountable M3
orchestrator on 6 October. The parent applied root rule 3's owner approval and
explicitly removed the earlier handoff's extra Sean-only gate. Preserve live
SDK-validated objects; reopening custom/cross-realm values requires the existing
tool-owned reconstruction capability, otherwise interrupt before effect.
Ordinary intrinsic JSON values retain their supported behavior. Before product
cutover, inventory affected actual tools and supply their existing required
reconstruction hooks or identify a concrete unsupported contract.

Qualify the prototype-carried regression together with
live/reopened arrays, numeric/async/Date transforms, historical call reuse and
tool-owned reconstruction. The complete milestone remains In Progress.

## Implemented bounded disposition and inventory

The predicate uses exact local Array/Object prototype identities and enumerable
own data properties; null-prototype data records remain supported. Live
validated values are untouched. Cross-realm arrays/records reopen only through
the existing explicit hook. The first failing prototype/SQLite receipt remains
retained above; no regression was skipped or weakened.

The actual native schema map derives from DESKTOP_NATIVE_TOOLS. Its authored
definitions/schemas contain no Date/class/custom-prototype/cross-realm transform;
the provider-compatible preprocessing normalizes optional nulls into ordinary
JSON values and defaults. Native canvas branch normalization also stays JSON.
MCP tools preserve server-provided raw JSON Schema through the public
toStandardSchema validator; no custom-prototype contract is required by that
shipped path. This source inventory does not promise arbitrary third-party
FlexibleSchema transforms are replayable. An extension requiring custom or
cross-realm runtime values without a hook now visibly interrupts before effect.

The inventory exposed a separate omission in the borrowed MCP adapter: it
discarded an explicitly supplied reconstruction hook. Its focused first failure
is retained at `/tmp/brainstrike-m3-reconstruction-hook-before.log`. The same
authority wrapper now preserves the hook's original receiver and generation,
retains its pending work, and joins it before releasing watches; this adds no
capability, gate or authority. The regression proves the exact returned runtime
object, original receiver, held close, post-close rejection and no execution.

Same-source host integration passed **72 cases with four Windows-only skips**
in 36.91 s, including thirteen runtime-meaning cases and all existing
numeric/async/Date/history/physical-owner regressions. Host units passed **93/93**
in 2.14 s. Existing native catalog/schema/worktree and MCP-client fixtures passed
**80/80** in 1.42 s. Logs: `/tmp/brainstrike-m3-reconstruction-final-integration.log`,
`/tmp/brainstrike-m3-reconstruction-final-unit.log` and
`/tmp/brainstrike-m3-reconstruction-catalog-regression.log`.

CI is disabled due to cost; validation must run locally.
