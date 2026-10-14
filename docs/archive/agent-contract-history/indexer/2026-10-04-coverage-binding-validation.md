# Coverage binding validation inside one snapshot

Validate each distinct canonical binding once within a coverage batch's owned
SQLite transaction. Preserve every request's authorization, full-profile check
and independent counts; discard validation state when the transaction ends.

Workspace and collection requests can select the same canonical file ID. Before
this change, their binding queries read and decoded that file twice despite
sharing the same authority inventory and WAL snapshot. The local set records an
ID only after `validateStoredBindings` succeeds. Subsequent overlapping requests
validate their remaining IDs, while full-profile storage validation retains its
separate set and runs even when a TEXT request already validated those bindings.

The production-connected native fixture records the actual SQL binding IDs and
rows returned to the existing decoder. The RED overlap batch retained ordered
chunk counts `[2, 3]` but queried four IDs and decoded four rows: `rooted` followed
by `rooted, retained, empty`. GREEN queries three IDs and decodes three rows:
`rooted` followed by `retained, empty`. Both versions issue two binding queries
for this partial overlap. The native complete-overlap control reduces two queries
and six returned rows to one query and three rows while retaining `[3, 3]` counts.
The driver-seam fixture also guards complete overlap and fresh singleton reads.

The fixtures retain disjoint/rootless and zero-chunk selections, incomplete
coverage for missing rows, fatal foreign metadata and invalid metadata bytes on
both the overlapping file and the second request's newly selected rootless file,
fresh rejection of corruption committed between transactions, and two distinct
complete profiles. The second profile's binding is shared by a TEXT request and
its vector request; successful metadata validation cannot skip that profile's
corrupt-vector rejection. The existing held-WAL test still observes one coherent
snapshot and rejects the next transaction after an external corrupt commit.

Only binding query and decoder work changes from the sum of selected binding
counts to their union. Selection, hashing and per-scope count work remain per
request. This is correctness and work-count evidence, not a measured performance
improvement or desktop M2 qualification. No acquisition, authority fence, reader
lifecycle, profile validation, SQLite engine setting or schema changes accompany
this change.

Guards: `packages/indexer/__tests__/coverage-file-lookup.integration.test.ts`,
`packages/indexer/__tests__/scoped-coverage-batch.test.ts`.
