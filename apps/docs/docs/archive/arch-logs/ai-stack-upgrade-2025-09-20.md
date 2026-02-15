---
title: "AI Stack Upgrade 2025 09 20"
---

# 2025-09-20 – AI Stack Upgrade (Mastra & Vercel AI SDK)

## Summary
- Upgraded `@ai-sdk/openai` to `^2.0.32` and regenerated lockfile.
- Upgraded Mastra dependencies in `packages/agent` to `@mastra/core@^0.17.0` and `@mastra/mcp@^0.13.0`.
- Verified compatibility of the custom Mastra agent runtime and MCP integration (no API changes required).

## Validation
- `pnpm type-check`
- `pnpm lint:eslint`
- `pnpm turbo run test --filter @brainstrike/agent`

## Follow-ups
- Monitor Mastra release notes for stability fixes post-0.17.0 (especially around streamVNext + structured output).
- Keep an eye on the AI SDK changelog for additional breaking changes in the v2 line.
- Do not unblock Zod v4 until `docs/mdc-rules/zod4-deferral-2025-09-20.md` exit criteria are satisfied.
