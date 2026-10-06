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

Owner decision pending: authorize this conservative existing reconstruction
contract, including explicit tool reconstruction for required cross-realm input,
or identify the required cross-realm callers and alternative owner contract.
After authorization, qualify the prototype-carried regression together with
live/reopened arrays, numeric/async/Date transforms, historical call reuse and
tool-owned reconstruction. The complete milestone remains In Progress.

CI is disabled due to cost; validation must run locally.
