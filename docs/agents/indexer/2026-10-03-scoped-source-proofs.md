# Scoped source manifests and profile coverage

Scope manifests must declare the whole current canonical binding inventory. Compare
all native file/chunk identities and source metadata in one read snapshot; profile
coverage counts actual complete source/coarse vectors, independently of search ranks.
The existing main receipt owner publishes readiness after successful joined production.

The collection/profile foundation supplied scoped publication and retrieval, while its
source-manifest and coverage methods remained root-only and tied to legacy workspace
paths/global vector state. Rootless collection receipts could not use those methods;
search hits, equal counts or top100 results cannot replace a full source manifest.
The coordinating owner approved this separate additive engine layer after clearing the
foundation and large-inventory correction review.

`verifyScopedManifest({scope,files})` declares canonical file IDs, nullable root/path,
scalar collection membership, actual source path, source hash and every expected chunk's
identity/hash/original index/span/type/size/token metadata. It rejects duplicate identities,
unnormalized workspace paths, forged bindings and partial/empty-for-nonempty inventories.
The native scope query includes stale rows even after catalog revocation, so missing,
changed and unexpected sets remain explicit. Descriptor order does not affect equality.
Empty source files retain a file row and an explicit zero-chunk declaration.

`coverageScope({scope,profile?})` validates the explicit full profile against current
bindings and reuses registry/Float32/coarse integrity checks from startup. Counts include
actual indexed files, chunks, selected-profile vectors and missing vectors; cached other
profiles never count. Empty scopes, unindexed canonical files or missing vectors cannot
claim vector completeness. TEXT requests return null profile/hash and zero vectors.
No profile is inferred from legacy workspace state or from the first returned hit.

Both return the existing store identity and authority epoch/revision. There is no new
receipt record, state machine, schema migration or persistence. Main still requires a
complete source manifest and successful joined publication with its current scan ticket;
coverage is not a source-scan receipt. Old root APIs remain compatible. Canonical manifests
reuse the existing missing/changed/unexpected comparison algorithm; binding selection,
stored-binding validation and vector validation are shared with the foundation.

RED process fixtures failed because the two scoped methods were absent. Initial GREEN
process fixtures demonstrate rootless/workspace collection members, full-inventory refusal,
stale extras, exact identities, empty files and reopen/epoch change. Profile coverage counts
all 101 vectors while retrieval returns only its 100 candidates, refuses an old selection,
retains cached profiles and detects a missing binary row. Captured production parser
metadata and above-driver-limit inventory cases extend those proofs.

Final local validation: clean then forced public dependency-closure build passes all ten
packages; strict source/test types and Effect diagnostics pass 29 files with no diagnostics.
All 46 integration tests across 11 files and four unit tests pass. The actual Electron
44.4.5 utility fixture also calls both new methods, verifies explicit-profile/TEXT counts
and checks stable store identity plus a changed epoch on reopen. No model inference is
claimed by its deterministic 1536-dimensional storage probe. Formatting and diff checks
pass before normal commit hooks. The 32768-binding fixture validates complete manifest
comparison and selected-profile counts with bounded parameters, while stale revoked rows
remain unexpected and unpublished canonical files prevent vector completeness.

CI is disabled due to cost; validation must run locally. These are engine proofs, not
composed readiness, performance, reset, packaged/native-platform or full M2 acceptance.
