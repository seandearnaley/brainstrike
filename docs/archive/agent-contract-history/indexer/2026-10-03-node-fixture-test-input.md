# Canonical Node fixture cache input

Canonical Node chunker, publication mapper and retained-coordinator tests hash
their own source/test files and the recorded source/chunk/graph fixture they
consume, preserving inherited inputs and task dependencies.

The public Node foundation's `node-chunking.test.ts` reads
`packages/indexer/__tests__/fixtures/canonical-provided-chunks.json` across the
package boundary. The original task inputs did not include it, so a recording
change could replay a stale unit or coverage result. The before/after dry graphs
show the missing input and its explicit hash after this scoped correction.

A preservation assertion exposed a related mistake in the initial correction:
`$TURBO_EXTENDS$` alone supplies no default files when the root task has no
explicit inputs. README and source files disappeared from the hash inventory.
The earlier mapper/coordinator additions had the same omission. Each of these
related consuming tasks now declares `$TURBO_DEFAULT$` as well as inherited
inputs and the external recording. The assertion checks every previous default
file and dependency, and the mapper/coordinator graphs explicitly retain their
product and test source files.

Only the three packages' consuming unit/coverage inputs change. Existing uncached integration
lane's public build prerequisite remains intact. No production source, parser,
recording, lockfile or global task definition changes.

CI is disabled due to cost; validation must run locally.
