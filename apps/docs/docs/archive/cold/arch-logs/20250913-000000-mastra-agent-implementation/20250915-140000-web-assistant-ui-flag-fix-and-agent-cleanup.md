---
title: "20250915 140000 Web Assistant UI Flag Fix And Agent Cleanup"
status: "cold-archive"
date: "2025-09-13"
superseded_by: "none"
---

Date: 2025-09-15
Owner: Core Platform (Brainstrike)

Summary
- Fixed web assistant-ui build flag so it evaluates as a boolean, not a truthy string.
- Removed stray compiled JS files under @brainstrike/agent/src to avoid type/behavior drift during dev and tests.

Details
- apps/web/vite.config.mts
  - Before: `globalThis.__VITE_ASSISTANT_UI__` was defined as the string 'false', which evaluates truthy at runtime via `Boolean('false')`.
  - After: flag now resolves to a boolean based on `APP_SHELL_ASSISTANT_UI` env: `true` enables assistant-ui on web, default is `false`.
  - Impact: Web defaults to legacy ChatPanel, consistent with current E2E assumptions; assistant-ui can be flipped on explicitly in CI/local.

- @brainstrike/agent cleanup
  - Removed `packages/agent/src/mcp/config.js`
  - Removed `packages/agent/src/memory/in-memory.js`
  - Removed `packages/agent/src/tools/schemas.js`
  - Rationale: These were compiled JS artifacts co-located with TS sources, risking stale imports and confusing tooling.

Validation
- Run: `pnpm turbo run type-check --filter ./...`
- Run: `pnpm turbo run build --filter ./...`
- Run: `pnpm turbo run test --filter ./...`

Next
- If/when we want web assistant-ui by default, set `APP_SHELL_ASSISTANT_UI=true` for that job or build.
- Proceed to tool parity on web or keep ChatPanel for tool cards until MCP-equivalent server wiring exists.

