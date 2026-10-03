# Retained coordinator delivery

Retained canonical ingestion joins its physical source/publication ownership
before reopening admission. Yielding generator cleanup is not completion.

The source coordinator `fcea6be3559d01c5d7c6083a870f28bc02b4f8b9` and required
retirement correction `dedf88c147af9dfbe5a8398052a541f73e626e2c` were reviewed
together. Never deliver the original coordinator without the correction.
This extraction retains the final package files from dedf. The twelve product,
test and package files remain byte-identical; its Turbo configuration additionally
hashes the canonical recording consumed by deterministic unit tests.
Its existing publication mapper is already on integration through PR3482, whose
merge is `bf5136d21cdf71978a64233b42d036ab1714c7eb`, the delivery base. Only the
new coordinator's exact importer is added to the current lockfile.

The first transplant build reproduced TS2305 because the coordinator imports
`CanonicalChunkEvent` through the file-import root barrel. The original five-line
type-only export from `95408a787` is included unchanged; the first prerequisite
slice exported the mapper/DTO but omitted this separate barrel. No host import is
redirected to a private source path.

The preserved causal RED ran the new yielding-finally cancellation/failure
regressions against the original coordinator; its lifecycle reopened admission
before generator retirement. The corrected source calls return once and drains
next until done, discarding cleanup yields while retaining physical ownership
and independent primary/cleanup failures.

The public plain-Node artifact exercises the actual canonical parser and recorded
chunks/graph with controlled ports. These ports are not a connected Electron
utility or authoritative PG adapter. Filesystem discovery/watch, new-file catalog
preparation, full profile/scoped readiness, hidden-renderer inference, reset and
other-platform qualification remain separate integration work.

Transplant checks: sixteen coordinator unit cases and one actual built public
Node case passed. The corrected dependency build passed all23 tasks with21
cached after the preserved first TS2305 failure. The dry task graph records the
external canonical fixture hash for unit tests and the existing public-artifact
build prerequisite for integration.

CI is disabled due to cost; validation must run locally.
