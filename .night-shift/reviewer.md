## Telemetry records copy only supported fields

**Learning:** Database query telemetry accepts public record objects at a runtime boundary. TypeScript excess-property checks do not prevent unsupported fields from reaching that boundary.

**Action:** Validate the record's own keys against the telemetry allowlist before reading values; never spread caller input into telemetry state.

## Cross-implementation telemetry needs production-seam coverage

**Learning:** File-tree database reads have both Base and Drizzle implementations. Instrumenting only one leaves the other production path without the query telemetry contract.

**Action:** When changing file-tree telemetry, enumerate both repository implementations and retain coverage for each production read seam.
