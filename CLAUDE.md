# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BrainStrike is a sophisticated AI-powered productivity suite built as a Turborepo monorepo with React 19, Vite, and TypeScript. It features both web and desktop applications with a comprehensive file explorer system and IDE-style interface.

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

# Full validation pipeline (required before commits)
pnpm run check  # install → lint → build → type-check → test → e2e
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
pnpm lint           # Biome linting
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
- **Package Manager**: pnpm 10+ with workspaces
- **Build System**: Turborepo with intelligent caching
- **Frontend**: React 19, Vite 6, TypeScript 5
- **Styling**: Tailwind CSS v4 with shared configuration
- **Testing**: Vitest (unit), Playwright (E2E)
- **Linting**: Biome (replaces ESLint/Prettier)

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
The `pnpm run check` command runs comprehensive validation:
1. Fresh dependency installation
2. Biome linting
3. Complete build of all packages/apps
4. TypeScript type checking
5. Unit and integration tests
6. End-to-end test suite

Always run this before submitting changes.

## Special Considerations

### Tokenizer Worker
- Located in `@brainstrike/utils`
- Requires Node.js 18+ with ESM support
- Uses OpenAI's tiktoken for accurate token counting
- Set `DISABLE_TOKEN_WORKER=1` to force heuristic mode
- Only available in Node.js environments (Electron main process)

### Performance
- Large directory handling requires virtualization
- Use `React.memo` for expensive component renders
- Implement proper error boundaries
- Zustand store updates should minimize re-renders

### IDE Layout System
- Multi-panel workspace with persistent panel states
- Left/right sidebars and console panel
- State preservation across sessions
- Documented in `docs/ide-layout.md`