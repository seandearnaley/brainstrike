# Isolated native coverage ownership

Keep fresh full-profile coverage validation off the canonical utility loop while retaining the native validator, authority and physical read ownership.

The retained 5,000-file run did not meet throughput or tool-latency gates after transaction-local coverage sharing. One cumulative embedding output stream covered exactly the final canonical vector count. Those observations did not isolate validation's share of the regression.

A two-file real RPC control on integration `e179e3a5` held the native full-profile iterator. The independent SQLite reader observed the writer's physical commit, but utility info and writer acknowledgements arrived only after release. The original proof patch remains on `codex/m2-coverage-rpc-ordering`, tree `6058df4ae56affc5d465747612aebda21d971f25`. That RED used a Node 24.16 donor runtime; it is not an Electron or new-build qualification.

The correction uses the existing sqlite-query process startup, bounded calls, cancellation, owner registry and exit joins. The native coverage mode transfers the utility's acknowledged authority explicitly, opens the existing better-sqlite3 reader, and performs unchanged batch validation with expected store/epoch checks in the owned read transaction. Generic SQL still constructs the same node:sqlite sandbox and refuses the native operation. A coverage owner refuses generic SQL.

The latch now runs in the actual isolated read child after its iterator establishes a WAL snapshot. The real canonical host returns info and acknowledges a physically visible write while that reader remains held. Cancellation, deadline and shutdown controls require the read host to exit before the caller settles. Fresh corruption and existing WAL controls preserve finite/nonzero Float32, coarse, ownership and schema rejection. The scale fixture uses the retained corpus root and path algorithm with conservative 64-character file IDs and separate full profile copies: the 5,000-file open envelope is 2,530,537 bytes against the explicit trusted 32 MiB bound. This is serialization evidence, not a new corpus generation or performance benchmark.

CI is disabled due to cost; validation must run locally. Hardware inference throughput, full app qualification, packaging/platform behavior and acceptance-gate improvement require separate measurement after source review. The causal control establishes progress isolation only.
