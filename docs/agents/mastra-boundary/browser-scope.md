# R4 browser scope — evidence

Supports `docs/agents/mastra-boundary.md` § "R4 BROWSER". Read this before
proposing a browser-driving agent or a `@mastra/agent-browser`-style dependency.


**Browser-driving agents are not a Brainstrike product capability.**

Core ships only `abstract class MastraBrowser` (`dist/browser/browser.d.ts:296`).
A working implementation requires `@mastra/agent-browser`, `@mastra/stagehand`, or
`@mastra/firecrawl` — none installed — plus a real Chromium either launched
locally or attached over CDP. Not renderer-viable (R2), and it would introduce
browser state, credentials, and consent as new ownership questions.

`webExtract` is a Tavily HTTP API call
(`apps/desktop/src/assistant-server/web-extract-tool.ts:289`), not a driven
browser, and does not change this.

Reopening requires a product decision naming which runtime owns browser state,
credentials, consent, and desktop/web parity.

