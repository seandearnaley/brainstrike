# Brainstrike web

The Vite/React app shares workspace UI with desktop. Browser storage and hosted
chat have their own boundaries; the web app does not run the desktop agent host.

## Development

Use the repository-pinned Node and pnpm versions. From the repository root:

```sh
pnpm install
pnpm dev --filter @brainstrike/web
```

Vite defaults to `http://localhost:8080`. Override the port with
`pnpm --filter @brainstrike/web dev --port 8081`; a `PORT` environment variable
is not the configured Vite port selector.

From `apps/web`:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the development server |
| `pnpm build` | Build into `dist/` |
| `pnpm start` | Serve the built app for preview |
| `pnpm test` | Run package unit tests |
| `pnpm test:integration` | Run package integration tests |
| `pnpm type-check` | Check app, test and API types |

## Runtime and configuration

The browser database still uses PGlite and pgvector. This does not imply desktop
uses that engine. Shared code discovers capabilities through its injected bridges;
unavailable native tools and desktop features are omitted.

Hosted model credentials belong to the server, never `VITE_` variables or a
browser bundle. The supported names and local configuration live in
[`.env.example`](.env.example). Production hosted chat remains disabled pending
application authentication and distributed quota/cost controls. Local development
and protected previews do not establish production acceptance. Built-in local
inference uses the browser-safe runtime.

[`vite.config.mts`](vite.config.mts) owns server/build configuration and
[`package.json`](package.json) owns commands. Shared UI and stores live in
`packages/`; app-owned entries live in `src/`, with hosted endpoints in `api/`.

## Validation

**CI is disabled due to cost; validation must run locally.** Select checks using
[validation guidance](../../docs/agents/ci-quality.md). The
[web E2E guide](e2e/README.md) covers built-preview and focused Playwright runs.
Follow the root [contribution policy](../../AGENTS.md).
