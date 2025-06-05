# BrainStrike Monorepo

BrainStrike is a 2025-ready Turbo monorepo for building AI-powered productivity tools. It uses Vite, React 19 and pnpm workspaces to keep development fast and maintainable.

## Quick Start

1. **Install dependencies**
   ```bash
   pnpm install
   ```
2. **Run the web app**
   ```bash
   pnpm dev --filter web
   ```
3. **Run the desktop app**
   ```bash
 pnpm dev --filter desktop & pnpm start --filter desktop
  ```

The desktop app is an Electron wrapper around the web UI. Styling is shared via
the same Tailwind configuration used by the web app.


## Requirements
- Node.js 22+ (see `.nvmrc`)
- pnpm 10+
- Each package.json declares `"engines": { "node": ">=22" }`

### Environment Requirements

#### Tokenizer Worker (Backend/Node.js)
The `@brainstrike/utils` package includes a tokenizer worker for accurate token counting:
- **Node.js 18+** with ESM support required
- Automatically uses OpenAI's tiktoken encoding for GPT-4 accuracy
- Falls back to heuristic estimation if worker is unavailable
- Set `DISABLE_TOKEN_WORKER=1` to force heuristic mode
- Note: The tokenizer worker is only available in Node.js environments, not browsers

## Repository Layout
```
apps/
  web/                 # Main Vite + React application
packages/
  ui/                  # Shared UI components
  hooks/               # Reusable React hooks
  utils/               # Common utilities
  types/               # Shared TypeScript types
  config/              # Tooling configuration
  storage/             # Cross-platform storage adapters
  file-system/         # Cross-platform file system adapters
  file-explorer/       # Core file analysis logic
  file-explorer-hooks/ # Hooks for file explorer domain
  file-explorer-ui/    # UI for file explorer features
  tailwind-config/      # Shared Tailwind CSS configuration
```

### Desktop App

`apps/desktop` contains an Electron wrapper around the web application. It uses
the same React components and Tailwind styles via the shared configuration.

## Toolchain Highlights
- **Vite** + **React 19** with **Tailwind CSS v4**
- **Turborepo** orchestrates builds and tasks
- **pnpm** for dependency management
- **TypeScript 5** for type safety
- **Biome** for linting and formatting
- **Vitest** & **Playwright** for testing
- **React Router** and **react-helmet-async** for routing and head management
- **Adapter Pattern** for the file explorer (storage & file system adapters enable web and Electron with in-memory/mocked options for tests)
- **IDE Layout** components for building multi-panel workspaces (see [docs/ide-layout.md](docs/ide-layout.md))

## Common Commands
```bash
pnpm dev --filter web        # Start local development
pnpm build                   # Build all apps and packages
pnpm test                    # Run unit and integration tests
pnpm test:e2e                # Run Playwright E2E tests
pnpm turbo run lint          # Lint the codebase with Biome
pnpm lint --fix              # Auto-fix lint issues with Biome
pnpm turbo run type-check    # Run TypeScript type checks
pnpm format                  # Auto-format source files
```

## Tailwind Config
Use the shared Tailwind configuration for any package. Extend it and provide your
own `content` globs:

```js
const base = require('@brainstrike/tailwind-config');

module.exports = {
  ...base,
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
};
```

## Configuration

See [docs/file-explorer-settings.md](docs/file-explorer-settings.md) for available file explorer settings.


## Contributing
- Follow [AGENTS.md](./AGENTS.md) for coding standards and workflow
- Use Conventional Commits for commit messages
- Ensure `pnpm lint --fix`, `pnpm format`, `pnpm type-check` and `pnpm test` all succeed
- See [`onboarding.md`](./onboarding.md) and [`monorepo-docs.md`](./monorepo-docs.md) for deep technical guides

The file explorer relies on `@brainstrike/storage` and `@brainstrike/file-system` packages which implement a platform-aware adapter pattern. Web, in-memory, and mock adapters enable browser usage, isolated tests, and pave the way for an Electron desktop app.

## License
ISC
