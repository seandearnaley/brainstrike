# BrainStrike Project Overview

## Purpose
BrainStrike is a context management suite for LLMs, featuring both web and desktop versions with a file explorer system and IDE-style interface.

## Tech Stack
- **Monorepo**: Turborepo with pnpm workspaces
- **Frontend**: React 19, Vite 7, TypeScript 5.9
- **Desktop**: Electron wrapper
- **Styling**: Tailwind CSS v4
- **Testing**: Vitest (unit), Playwright (E2E)
- **Linting**: Biome 2.2.3
- **Database**: PGLite (PostgreSQL in browser)
- **Node**: v22+ required

## Architecture
- 2 apps: web and desktop
- 22 shared packages following adapter pattern for cross-platform support
- Platform-agnostic core with adapters for Node.js, Web API, and testing

## Key Patterns
- Adapter pattern for file system and storage operations
- Shared UI components from @brainstrike/ui
- Strict TypeScript with no 'any' types
- 70% test coverage threshold enforced
