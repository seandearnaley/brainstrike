---
title: "20250915 130000 Web Assistant Ui Default On"
status: "cold-archive"
date: "2025-09-13"
superseded_by: "none"
---

Date: 2025-09-15
Owner: Core Platform (Brainstrike)

Summary
- Assistant‑UI is now ON by default on web builds.
- Fallback to ChatPanel is no longer used in web (kept as a code path for safety but unreachable by default).

Changes
- apps/web/vite.config.mts
  - `globalThis.__VITE_ASSISTANT_UI__` now defaults to `true` via `APP_SHELL_ASSISTANT_UI !== 'false'`.
  - To disable assistant‑ui (rare), set `APP_SHELL_ASSISTANT_UI=false` at build/runtime.
- E2E updated to assistant‑ui semantics:
  - `apps/web/e2e/assistant-panel.test.ts`: asserts `assistant-ui-viewport` and assistant streaming.
  - `apps/web/e2e/assistant-panel-interactions.test.ts`: Stop/Retry work with assistant‑ui buttons.

Notes
- Server routes for assistant‑ui are wired (`/api/assistant`) and include a basic `web.echo` tool with progress.
- If richer tools are required on web, add server-backed tool dispatchers and schema validation similar to desktop MCP.

