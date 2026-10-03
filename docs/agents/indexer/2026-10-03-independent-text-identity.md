# Text storage and explicit vector identity — 2026-10-03

A text store has an explicit text-only state and stable store ID. Initial vector
configuration is atomic and never invents a profile or erases canonical rows.

The measured BST-1922 retrieval gate failed on the canonical corpus. The approved
M2 policy therefore selects TEXT by default and vector retrieval only by explicit
opt-in. The prior complete-profile acquisition contract was insufficient: selected
renderer model settings expose ID/key/dimensions, while actual worker dtype/device
is dynamic and immutable revision is absent. In particular, the canonical WASM
384-dimensional default can be q4, which the qualified native profile excludes.
Requiring inference or guessing q8 merely to create text storage would violate
that policy. The prior acquisition design is replaced for this reason.

Derived schema4 records store_id plus index_mode with constrained optional vector
metadata. Public ready/search/coverage DTOs carry storeId and embedding union;
text-only has no vector profile/hash. Chunk embedding hashes remain explicitly
null until configuration. Existing schema versions refuse rebuild-required and
preserve their files. Explicit open-existing acquisition occurs inside the
utility, requires an existing file and validates its stored identity; a configured
store remains configured even when the current UI selects TEXT. Explicit requests
for text-only against a configured store still refuse identity mismatch.

Real process RED rejected acquisition without profile. GREEN exercises model-free
text ingest/search/reopen, vector API refusal, complete profile configuration,
stale-plan refusal, strict actual vector backfill, idempotent same-profile and
different-profile refusal. An actual SQLite trigger aborts chunk hash changes
after metadata update; rollback preserves text-only metadata/chunks. Captured
canonical parser symbols/refs remain byte-for-byte unchanged across successful
configuration. Coverage and reopen reject invalid chunk/profile identity;
open-existing refuses missing, corrupt metadata and prior-schema stores without
creating or erasing their text.

Actual Electron44.4.5 utility proof starts in text-only mode, explicitly configures
vectors, performs incremental replacement, reopens the stored configured identity
and joins reset. Caller deadlines and process/reader ownership remain enforced.
These checks establish this boundary on Mac arm64, not full product integration,
Linux/Windows packaging, corpus throughput or a passing retrieval-quality gate.
The earlier corpus measurement remains pinned to a03a8fec and its schema2 runtime;
it is not reassigned to this layer. Hosted CI remains disabled due to cost.
