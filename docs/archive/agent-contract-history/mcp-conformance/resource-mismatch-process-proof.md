# Resource-mismatch rejection and process proof

Supports `docs/agents/mcp-conformance.md` § "MCP verification harness".

Post-merge MCP Verification [run 36206814939](https://github.com/seandearnaley/brainstrike/actions/runs/36206814939) on September 26, 2026 timed out in `2026-07-28/auth/resource-mismatch` after 45,033 ms. Cleanup was confirmed and the other ten modern scenarios passed. The preceding commit's official run passed, and the merge changed no MCP runtime or verifier code. A local modern profile, Linux ARM/Node 26.8.2 profile, and repeated isolated scenarios did not reproduce the stall. These passes do not identify its cause.

Investigation exposed a separate proof gap in the pinned alpha.10 fixture: a client command that exits immediately with status 1 can still pass because the negative check only observes that no authorization request occurred. Passing this one official scenario is therefore insufficient evidence that the production client reached protected-resource discovery or rejected the intended mismatch.

The independent production-host regression requires an actual MCP request and the specific protected-resource mismatch failure, with no authorization or registration. Process coverage additionally requires the production entry to exit after that rejection and rejects an early-exit control. These checks complement the official profile rather than replace it. They do not increase timeouts, accept expected failures, force successful process exit, or establish a root cause for the original intermittent CI timeout.
