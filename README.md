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

## Requirements
- Node.js 22+ (see `.nvmrc`)
- pnpm 10+
- Each package.json declares `"engines": { "node": ">=22" }`

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
```

## Toolchain Highlights
- **Vite** + **React 19** with **Tailwind CSS v4**
- **Turborepo** orchestrates builds and tasks
- **pnpm** for dependency management
- **TypeScript 5** for type safety
- **Biome** for linting and formatting
- **Vitest** & **Playwright** for testing
- **React Router** and **react-helmet-async** for routing and head management
- **Adapter Pattern** for the file explorer (storage & file system adapters enable web and Electron with in-memory/mocked options for tests)

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

## Contributing
- Follow [AGENTS.md](./AGENTS.md) for coding standards and workflow
- Use Conventional Commits for commit messages
- Ensure `pnpm lint --fix`, `pnpm format`, `pnpm type-check` and `pnpm test` all succeed
- See [`onboarding.md`](./onboarding.md) and [`monorepo-docs.md`](./monorepo-docs.md) for deep technical guides

The file explorer relies on `@brainstrike/storage` and `@brainstrike/file-system` packages which implement a platform-aware adapter pattern. Web, in-memory, and mock adapters enable browser usage, isolated tests, and pave the way for an Electron desktop app.

## License
ISC
