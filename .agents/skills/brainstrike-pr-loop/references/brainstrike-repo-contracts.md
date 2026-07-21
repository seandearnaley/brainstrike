# Brainstrike Repo Contracts

This is the minimum repo-specific contract set to keep in working memory while running a PR loop in the Brainstrike repository.

## Operating Style

- No fallbacks.
- No silent degradation.
- No guessing.
- No hand waving.
- Verify behavior in code, tests, or concrete logs before claiming it is fixed.

## Required Local Validation

Before push, Brainstrike expects full root gates to pass together:

```bash
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

CI is there to double-check, not to discover basic breakage you could have caught locally.

## PR Loop Discipline

- Review comments arrive faster than CI; read them before waiting on checks.
- Every push restarts expensive pipelines; batch cheap, clearly correct fixes.
- Cancel superseded GitHub Actions runs as soon as a newer push exists.
- Keep one watcher loop alive with `sleep` instead of opening many overlapping polling sessions.
- Always anchor CI investigation to the latest head SHA.

## Testing Standard

- Use red/green TDD for real review items and CI failures.
- Add or tighten regression tests before implementing fixes.
- Prefer targeted tests while iterating, then run the full root gates before push.
- Desktop E2E flakiness should be diagnosed, not bypassed.

## Architecture Reminders

- Renderer-only execution is mandatory for local embedding work.
- Do not move embedding or local model execution into Electron main.
- AGENTS.md is authoritative when architecture, lifecycle, or reset behavior is involved.

## Merge vs Follow-Up

Night Shift loops never merge: for any `night-shift/*` branch or run governed
by `.night-shift/PROTOCOL.md`, the terminal state is the protocol's
`status=READY` checkpoint and human hand-off (see the SKILL.md "Night Shift
mode" section). The guidance below is for human-driven PR work only.

Merge now when:

- the core feature is stable
- the latest required checks are green
- remaining issues are mostly hardening or scope expansion

Split follow-up work when:

- the remaining items materially widen scope
- the core behavior is already solid
- further changes would create more CI churn than product value in the current PR
