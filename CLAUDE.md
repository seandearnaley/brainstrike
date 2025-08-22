# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BrainStrike is a suite of tools for context management to be used with LLMs. It is a Turborepo monorepo with React 19, Vite, and TypeScript apps+packages. It features both web and desktop versions with a file explorer system and IDE-style interface.

Do not attempt to run dev unless instructed to do so.  The user usually runs this for you.


## Development Commands

### Core Development
```bash
# Install dependencies
pnpm install

# Start web application (localhost:8080)
pnpm dev --filter web

# Start desktop application (Electron)
pnpm dev --filter desktop
pnpm start --filter desktop  # Launch Electron after dev server

# Build all packages and applications
pnpm build

# Full validation pipeline (required before commits, note over 10 minutes to run)
pnpm check  # install → lint → build → type-check → test → e2e
```

### Testing & Quality
```bash
# Unit/integration tests across monorepo
pnpm test

# E2E tests with Playwright
pnpm test:e2e
pnpm test:e2e:ui     # With UI
pnpm test:e2e:debug  # Debug mode

# Code quality
pnpm lint           # Lint and apply safe fixes with Biome
pnpm format         # Auto-format with Biome
pnpm type-check     # TypeScript validation
```

## Architecture & Package System

### Monorepo Structure
- **`apps/web`**: Vite + React 19 web application
- **`apps/desktop`**: Electron wrapper for native desktop experience
- **`packages/`**: 13+ shared packages with specific purposes

### Key Packages
- **`@brainstrike/ui`**: React components based on shadcn/ui + Radix
- **`@brainstrike/file-explorer`**: Core file analysis logic (platform-agnostic)
- **`@brainstrike/file-system`**: Abstracted file operations with adapters
- **`@brainstrike/storage`**: Persistent storage with platform adapters
- **`@brainstrike/app-shell`**: IDE-style layout system
- **`@brainstrike/types`**: Shared TypeScript definitions

### Adapter Pattern
Critical architectural pattern enabling cross-platform functionality:
- **File System Adapters**: Node.js, Web API, In-memory (for tests)
- **Storage Adapters**: LocalStorage (web), electron-store (desktop), In-memory (tests)
- Core business logic remains platform-agnostic

## Development Guidelines

### Technology Stack
- **Node.js**: 22+ required (check `.nvmrc`)
- **Package Manager**: pnpm 10.15.0+ with workspaces
- **Build System**: Turborepo with intelligent caching
- **Frontend**: React 19, Vite 7, TypeScript 5.9
- **Styling**: Tailwind CSS v4 with shared configuration
- **Testing**: Vitest (unit), Playwright (E2E)
- **Linting**: Biome 2.1.3

### Code Standards
- **TypeScript**: Strict mode enabled across all packages
- **File Naming**: kebab-case enforced by Biome
- **Components**: Functional components with hooks only
- **State Management**: Zustand for global state in web app
- **Commits**: Conventional Commits enforced via commitlint

### Package Dependencies
- Use `workspace:*` protocol for internal package references
- Always check existing packages before adding new dependencies
- Prefer shared packages over duplicating code in apps
- Follow topological build order enforced by Turborepo

### Testing Strategy
- Co-locate tests with source files using `__tests__` directories
- Unit tests: `*.test.ts`
- Integration tests: `*.integration.test.ts`
- Maintain 70%+ test coverage threshold
- Use Happy DOM for browser environment simulation


## Common Patterns

### File Explorer Integration
When working with file operations:
1. Use `@brainstrike/file-explorer-hooks` for React integration
2. Leverage `@brainstrike/file-system` adapters for platform abstraction
3. Check existing file processing utilities in `@brainstrike/utils`

### UI Development
- Use components from `@brainstrike/ui` for consistency
- Follow Tailwind v4 shared configuration
- Implement proper light/dark theme support
- Ensure WCAG compliance with Radix primitives

### Cross-Platform Considerations
- File paths: Use adapter pattern, never assume Node.js APIs
- Storage: Use `@brainstrike/storage` adapters
- Environment detection: Check platform capabilities before using APIs

## Build System

### Turborepo Configuration
- Topological builds with dependency awareness
- Shared caching across local and CI environments
- Parallel execution where possible
- Filtered builds: `--filter web` or `--filter desktop`

### Validation Pipeline
The `pnpm check` command runs comprehensive validation:
1.  **Dependency Installation**: `pnpm install` ensures all dependencies are correctly installed.
2.  **Linting & Formatting**: `pnpm lint-all` runs the linter and formatter.
3.  **Building**: `pnpm build` builds the entire monorepo.
4.  **Type Checking**: `pnpm type-check` resolves TypeScript errors.
5.  **Unit & Integration Testing**: `pnpm test` runs all unit and integration tests.
6.  **End-to-End Testing**: `pnpm test:e2e` executes Playwright E2E tests.

Always run this before submitting changes.


ALWAYS CONSULT THE WEB FOR BEST PRACTICES WITH THE TECHNOLOGY STACK.

SEARCH FOR THIS YEARS BEST PRACTICES eg 2025 NOT 2024.  

Never downgrade to get something working.

Don't use defensive fallbacks, if something is not working, we need to fail fast and fix it- Do not disable, reward hack or any false workaround, turning something off is not a solution- always do your solutions PROPERLY.
