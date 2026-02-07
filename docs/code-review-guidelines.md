# BrainStrike Code Review Guidelines

These guidelines define how we review code in this monorepo.

Goals:
- Catch correctness, determinism, architecture, and performance issues before merge.
- Keep feedback high-signal, evidence-based, and actionable.
- Prefer modern patterns over legacy patterns while keeping guidance durable.

This is a living document. Keep it aligned with `AGENTS.md`, workspace architecture, and CI behavior.

## 1. Review Contract (What Good Looks Like)

A change is review-ready when all of the following are true:

- Correctness: behavior is correct for happy path and failure paths.
- Determinism: same inputs and state produce same outputs and side effects.
- Performance: no obvious regressions in runtime, render cost, memory, or bundle behavior.
- Test evidence: tests prove behavior and protect against regressions.
- Architecture: change respects package boundaries and known system invariants.
- Simplicity: implementation is clear, minimal, and avoids unnecessary abstraction.

## 2. Reviewer Workflow

Use this sequence to keep reviews efficient and consistent.

1. Scope and risk triage
- Read PR description, touched files, and dependency graph impact.
- Classify change risk: low, medium, high.
- Identify affected runtime(s): web, desktop (main), desktop (renderer), shared package.

2. Invariants pass
- Check monorepo and architecture invariants first (Section 4).
- If an invariant is violated, block review and request redesign/fix.

3. Correctness and determinism pass
- Validate state transitions, concurrency behavior, retries/timeouts, and ordering assumptions.
- Look for hidden non-determinism (time/randomness/global mutable state).

4. Performance pass
- Inspect critical paths, rendering hot spots, and I/O scheduling.
- Require evidence for non-trivial performance claims.

5. Tests and observability pass
- Ensure tests cover behavior and edge cases, not just code lines.
- Confirm logs/errors are structured and safe.

6. Feedback quality pass
- Provide severity, concrete evidence, impact, and suggested direction.

## 3. Severity Model

Use a consistent severity rubric in review comments.

| Severity | Meaning | Expected action |
| --- | --- | --- |
| P0 | Data loss, security risk, major production break, invariant violation | Must fix before merge |
| P1 | High-confidence correctness/performance regression | Must fix before merge |
| P2 | Maintainability/testability risk likely to cause future bugs | Fix now or create tracked follow-up |
| P3 | Style/nit/documentation improvement | Optional unless repeated pattern |

A strong comment includes:
- Observation: what is wrong and where.
- Impact: why it matters (user/system risk).
- Evidence: test, trace, docs, or concrete scenario.
- Direction: smallest safe fix path.

## 4. BrainStrike-Specific Non-Negotiables

These are hard constraints for this repository.

### 4.1 Local-First and latency-critical behavior

- Do not introduce round-trip dependencies on user-critical local interactions.
- Favor client-resident state and local execution for hot paths.
- Flag patterns that block on remote APIs for interactions that should stay local.

### 4.2 Embedding runtime architecture

- Embedding worker must run in renderer/browser context.
- Do not move embedding execution into Electron main process.
- Main process should manage lifecycle and IPC, not heavy embedding compute.

### 4.3 Queue semantics and determinism

- Preserve lease/claim/retry semantics in the job queue.
- Verify idempotency and dedupe paths for enqueue/retry.
- Ensure failure handling does not double-count attempts or produce orphaned states.

### 4.4 Factory reset contract

Factory reset must produce a true fresh start:
- Clear renderer persistent UI state.
- Clear IndexedDB and CacheStorage paths covered by reset helper.
- Purge DB tables used by indexing/embeddings.
- Reload renderer after reset pipeline.

Any new persistence layer must be added to the reset pipeline in the same PR.

### 4.5 Logging and sensitive data

- Use structured logging (`@brainstrike/utils` logger), not ad-hoc console output.
- Ensure secrets/tokens are never logged.
- New sensitive fields must be added to redaction paths.

## 5. Determinism Review Checklist

Determinism is required for reliable retries, caching, tests, and user trust.

Review for these foot-guns:

- Hidden time dependency: direct `Date.now()` usage in core logic without injection.
- Hidden randomness: `Math.random()` in logic/tests without deterministic control.
- Ordering assumptions:
  - relying on object key iteration for business behavior,
  - unstable sorts without explicit comparator,
  - racey “first finished wins” logic without tie-breaking.
- Shared mutable state across async boundaries without synchronization.
- Non-idempotent retries for queue, storage, or side-effecting commands.
- Inconsistent serialization/parsing paths across web/desktop runtimes.

Prefer:
- Explicit clock/id providers where determinism matters.
- Idempotency keys and dedupe semantics for retriable operations.
- Stable sort/comparison rules.
- Pure transformation functions for state derivation.

## 6. Performance Review Checklist

### 6.1 UI/render performance (React)

- Avoid Effects for derived state or pure calculations.
- Ensure expensive computations are memoized only when profiling justifies it.
- Verify list-heavy UIs are virtualized and keyed correctly.
- Check for unnecessary re-renders from unstable object/function props.
- Use concurrent-friendly patterns and avoid blocking work in render.

Red flags:
- “Fixing” render loops with ad-hoc dependency suppression.
- State duplicated across hooks/components without a clear source of truth.
- Heavy sync transforms in render path for large datasets.

### 6.2 Electron/process performance

- Main process must not run CPU-heavy work that can block UI responsiveness.
- Large file/DB/embedding operations should be scheduled in worker or renderer-safe paths.
- Validate IPC frequency/payload size in hot paths.

### 6.3 Data and I/O performance

- Validate query/index behavior for changed DB access paths.
- Prevent N+1 reads and repetitive serialization work.
- Ensure queue batching and backpressure behavior remains intact.

### 6.4 Build/CI and monorepo performance

- Turborepo tasks must declare correct outputs/inputs/env dependencies.
- Avoid cache-hostile scripts with hidden global side effects.
- Prefer scoped execution (`--filter`) for package-local changes.

## 7. Code Quality and Simplification Checklist

### 7.1 Simplification-first

- Prefer deleting complexity over adding indirection.
- Collapse duplicate logic into shared helpers only when abstraction is stable.
- Reject abstractions that are used once or hide critical behavior.

### 7.2 Type safety

- Avoid `any`; use `unknown` + narrowing.
- Preserve strict typing at package boundaries.
- Prefer discriminated unions and explicit domain types over loose dictionaries.
- Validate untrusted input at boundaries (IPC, storage, network, user input).

### 7.3 Maintainability

- Function and component responsibilities should be clear and focused.
- Branch complexity should remain readable; extract named predicates/helpers.
- Names should encode intent, not implementation mechanics.

### 7.4 API and package boundaries

- Prevent cross-layer leakage (UI reaching into storage internals, etc.).
- Keep public package APIs intentional and minimal.
- Avoid hidden coupling through globals or implicit singleton state.

## 8. Testing Standards for Reviews

### 8.1 Test requirement by change type

- Pure logic changes: unit tests for behavior and edge cases.
- State orchestration changes: integration tests for transitions and failure handling.
- User flow changes: E2E coverage for critical workflows.
- Concurrency/retry/queue changes: deterministic tests for leases/retries/idempotency.

### 8.2 What makes a test review-worthy

- Deterministic: no arbitrary sleeps, no time/race dependence.
- Behavioral: tests assert outcomes/contract, not implementation details.
- Negative paths: includes failure/retry/error propagation behavior.
- Cross-runtime fit: where relevant, validates both desktop and web behaviors.

### 8.3 Flake prevention

- Prefer Playwright locators and web-first assertions over timing hacks.
- Prefer fake timers or explicit clock control for timeout/retry logic.
- Avoid shared mutable fixtures between tests.

## 9. Modern Patterns to Prefer (And Legacy Patterns to Flag)

### 9.1 React/Frontend

Prefer:
- Computing derived values during render when possible.
- Effects only for synchronization with external systems.
- Explicit runtime boundaries between web, Electron main, Electron renderer, and shared packages.

Flag:
- Legacy class lifecycle patterns for new work.
- Effect chains used as dataflow engines.
- Blanket memoization without measured benefit.

### 9.2 TypeScript/Node

Prefer:
- Explicit narrowing for unknown data.
- Exhaustive checks for discriminated unions.
- Non-blocking patterns for CPU-heavy or long-running tasks.

Flag:
- Implicit coercions at boundaries.
- Silent fallbacks that mask root-cause failures.
- Event-loop blocking logic in high-throughput paths.

## 10. Common Foot-Guns in This Monorepo

Reviewers should proactively scan for these:

- Reintroducing embedding worker startup in Electron main.
- Adding persistence without reset-pipeline integration.
- Breaking queue lease/idempotency assumptions.
- Introducing cross-package circular dependency through convenience imports.
- Modifying shared configs in feature PRs without explicit approval.
- Using non-deterministic test constructs (sleep-based assertions).
- Shipping `console.log`/debug traces instead of structured logger usage.

## 11. PR Acceptance Checklist (Reviewer + Author)

Use this checklist before merge:

- [ ] Architecture invariants preserved (local-first, embedding runtime, queue, reset contract).
- [ ] No determinism hazards in core logic or tests.
- [ ] Performance risks evaluated; evidence provided for risky changes.
- [ ] Simplification attempted; unnecessary complexity removed.
- [ ] New behavior covered by appropriate test level(s).
- [ ] Errors/logs are actionable and redact sensitive data.
- [ ] Workspace boundaries and public APIs remain clean.
- [ ] Documentation updated where behavior/contracts changed.

## 12. Validation Commands

Minimum expected verification for non-trivial code changes:

```bash
pnpm build
pnpm lint
pnpm type-check
pnpm test
```

When touching E2E-critical flows:

```bash
pnpm test:e2e
pnpm test:e2e:desktop
```

When scoping during iteration, use `turbo`/`pnpm --filter` for speed, then run full checks before merge.

## 13. Review Reasoning Template

Use this structure for high-signal comments:

1. Context: “In `<file>:<line>`, this path handles `<scenario>`.”
2. Risk: “This can fail/regress because `<mechanism>`.”
3. Evidence: “Repro via `<test/steps/logs/docs>`.”
4. Fix direction: “Prefer `<specific approach>` to preserve `<invariant>`.”

## 14. Sources and Further Reading

Primary sources used to align these guidelines with current ecosystem practices:

- React docs: [Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects)
- React docs: [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
- React docs: [Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks)
- React docs: [Strict Mode](https://react.dev/reference/react/StrictMode)
- Turborepo docs: [Configuring Tasks](https://turborepo.com/docs/crafting-your-repository/configuring-tasks)
- Turborepo docs: [Caching](https://turborepo.com/docs/crafting-your-repository/caching)
- Vitest docs: [Mocking](https://vitest.dev/guide/mocking)
- Vitest docs: [Parallelism](https://vitest.dev/guide/parallelism)
- Playwright docs: [Best Practices](https://playwright.dev/docs/best-practices)
- Playwright docs: [Auto-waiting](https://playwright.dev/docs/auto-waiting)
- TypeScript docs: [Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- TypeScript docs: [Type Compatibility](https://www.typescriptlang.org/docs/handbook/type-compatibility.html)
- Node.js docs: [Don't block the event loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
- web.dev: [Core Web Vitals](https://web.dev/articles/vitals)

## 15. Maintenance Cadence

- Revalidate this document quarterly or after major architecture/tooling changes.
- If AGENTS constraints change, update this file in the same PR.
- If React/Turbo/Vitest/Playwright guidance changes materially, update Section 9 and sources.
