# Discovery preparation before canonical publication

The utility coordinator now distinguishes a granted workspace discovery's
path/name/stat data from an actual PG canonical identity. Unresolved discoveries
carry no file ID or invented collection membership. The same explicit scan batch
bound counts registered, removed and unresolved entries together.

Original secure source is read and SHA256-hashed before the required main
preparation port runs. Main owns actual root/path identity lookup, UUID allocation,
real-content managed-cache mutation and full trusted native binding replacement.
The port acknowledges all of that before returning canonical identities. Utility
validates exact root/path/name/source/hash, represented membership, unique nonblank
IDs and scan-wide identity uniqueness before feeding the one canonical parser.
Root/path metadata never authorizes I/O. Workspace preparation does not establish
new filesystem membership for a retained collection scope.

RED observed the accepted coordinator complete a discovery without calling its
required preparation operation. Paired host tests now cover original source and
exact canonical chunks, held preparation acknowledgement, physical cancellation
join, failed or incomplete/mismatched replies, batch bounds and identity replay.
The prior registered authorization/stat-skip/rootless/retirement tests remain.

Plain Node public-entry cases exercise registered/rootless and unresolved
workspace preparation through controlled catalog/publication ports. They qualify
the coordinator/parser boundary, not real PG mutation or engine binding delivery.
Actual mounted SecureRoot lease, utility discovery/watchers, main transport,
native receipt, reset and composed app acceptance remain separate required work.

Independent review found a path-identity gap in the first preparation layer:
registered entries recorded IDs while unresolved entries alone recorded paths.
A registered path could reappear unresolved under another prepared ID, or vice
versa, publishing twice and reporting complete. Three causal regressions
reproduced completion in both orders and a mixed batch before the correction.
One root/path set now guards registered, removed and unresolved admission before
the conflicting batch reads or prepares anything. The file-ID guard remains;
nullable retained roots/paths are not conflated. A distinct retained-ID/null-path
control and the separate different-path/repeated-ID case preserve those rules.
Cancellation, yielding iterator retirement and receipt predicates are unchanged.
