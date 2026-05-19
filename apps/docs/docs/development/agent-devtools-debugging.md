---
title: Agent DevTools Debugging
sidebar_position: 7
---

# Agent DevTools Debugging

Use this workflow when an agent needs live DOM, console, network, screenshot, performance, or computed-state visibility into the desktop renderer.

## Start Brainstrike

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug
```

The launcher prints:

- The isolated user data directory.
- The CDP endpoint, usually `http://127.0.0.1:9222`.
- A temporary MCP config for `chrome-devtools-mcp`.

## Codex MCP Config

```json
{
  "mcpServers": {
    "brainstrike-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@0.26.0",
        "--browser-url=http://127.0.0.1:9222",
        "--no-usage-statistics"
      ]
    }
  }
}
```

## What Agents Can Inspect

- Accessibility snapshot.
- Console messages.
- Network requests.
- Screenshots and screencast.
- DOM state through script evaluation.
- Computed style through `window.getComputedStyle`.
- Local/session storage through page evaluation.

## Guardrails

- Do not enable this mode in packaged production builds.
- Keep the endpoint bound to `127.0.0.1`.
- Use the isolated profile created by the launcher.
- Do not add a fixed remote debugging port to normal Playwright E2E.
- Use `--inspect=9229` separately for Electron main-process debugging.

## Troubleshooting

- If `chrome-devtools-mcp` cannot attach, open `http://127.0.0.1:9222/json/list`.
- If no target appears, verify `BRAINSTRIKE_AGENT_DEVTOOLS=1` reached Electron main.
- If normal E2E hangs at shutdown, remove fixed debug-port arguments from the default harness.
- If an agent cannot see Electron targets, use Playwright `_electron.launch()` as the fallback debugger.
