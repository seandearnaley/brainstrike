# Zod v4 Migration

Date: 2026-01-16

## Summary
This document captures the Zod v4 migration patterns adopted in the codebase and the places that required updates. The focus is on consistent validation behavior, stable error reporting, and avoiding private APIs.

## Breaking Changes Observed
- Error object shape should be treated as potentially unstable across major versions. Access to `error.issues` must be defensive.
- Private schema internals (such as `._def`) are not stable and should not be relied on in tests.

## Adopted Patterns
1) Prefer `superRefine` for custom validation logic
- Use `ctx.addIssue` with explicit `ZodIssueCode.custom`.
- Keeps validation logic aligned with Zod v4 guidance and existing code patterns.

2) Defensive error issue formatting
- When building error responses, guard issue paths to avoid runtime failures if the error shape changes.
- Always coerce `issue.path` safely and avoid direct `.join('.')` on unknown structures.

3) Behavior-first tests
- Replace private `_def` inspections with tests that validate observable behavior.

## Files Updated
- `apps/desktop/src/ipc-handlers.ts`
  - Migrated `sizes` validation to `superRefine`.
- `packages/agent/src/tools/schemas.ts`
  - Defensive formatting for `error.issues`.
- `packages/agent/src/mcp/config.ts`
  - Defensive formatting for `error.issues`.
- `apps/web/src/app/api/chat/route.ts`
  - Defensive formatting for `error.issues`.
- `packages/selection-rules/src/__tests__/validation.test.ts`
  - Removed `_def` access, added behavioral discriminated union checks.

## Testing Notes
- Full suite: `pnpm build && pnpm lint && pnpm type-check && pnpm test`
- Zod validation behavior is also covered by unit tests in:
  - `packages/selection-rules`
  - `packages/agent`
  - `apps/web`

## Guidance for Future Changes
- Avoid accessing Zod private internals.
- Prefer `superRefine` for custom validation logic.
- Keep error reporting resilient to schema changes.
