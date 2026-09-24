# Phase 2 boundaries — evidence

Supports `docs/agents/effect-boundary.md` § "Schema at boundaries". The record
of which runtime boundaries moved to Effect Schema in Phase 2 of ADR-0004, what
each move found, and what stayed hand-written (2026-09-24, effect
4.0.0-rc.117).

## PGlite rows: the MCP task repository

- `packages/db/src/repositories/mcp-task-row-schema.ts` declares every field
  rule of `brainstrike_mcp_tasks` and `brainstrike_mcp_task_authorities` once.
  The same schemas decode rows read back from PGlite and validate the status,
  metadata, blocked-diagnostic, status-message, and clock inputs a caller
  passes to `create`/`update`. The repository dropped the `as unknown as
  McpTaskRow` cast and nine hand-written `require*` helpers (756 -> 635 lines).
- Each schema's `message` is the sentence the old helper threw, so the
  integration suite's regex fragments (`/timestamp/u`, `/monotonic/u`, and the
  rest) match unchanged. A row failure now also names the failing column, for
  example `MCP task history.at must be a valid timestamp.` then
  `at ["history"][0]["at"]` on a second line.
- `Schema.NullOr` keeps the member's own message when the non-null member
  fails, so `blocked_diagnostic` still reports "fields are invalid" versus
  "values are invalid" separately.
- The cross-field rules (canonical resource URL, terminal timestamp versus
  status, monotonic history ending at `updatedAt`) stay as code over the decoded
  record. They read two or more columns, and the camelCase record is where their
  messages make sense.
- In a Node probe, `Schema.Date` rejected an invalid `Date` with its own
  "Expected a valid Date" before a later filter could run; the timestamp schema
  therefore annotates `Schema.Date` itself.
- `SchemaTransformation.transform` needs explicit type parameters
  (`transform<Date, unknown>`) when the encoded side is `unknown`; inference
  otherwise picks `Transformation<Date, Date>` and fails to type-check.

## Row counts: the file-chunk repositories

- A real PGlite 0.5.8 `DELETE` result carries `rowCount` and `affectedRows`,
  but the desktop DB host protocol surfaces only `rows`. So
  `ElectronFileChunkRepository.delete` always returned `false` (`undefined > 0`)
  and `deleteByFileRecordId` returned `undefined` typed as `number`; the
  `as unknown as { rowCount: number }` cast hid it. Both raw repositories now
  count `RETURNING id` rows, as the Drizzle repository already did. No Schema
  was needed: a query that returns rows needs no count field at all.
- No production caller read either return value, which is why nothing failed.
  The tests now pin the counts on both transports.
