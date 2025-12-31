# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BrainStrike is a suite of tools for context management to be used with LLMs. It is a Turborepo monorepo with React 19, Vite, and TypeScript apps+packages. It features both web and desktop versions with a file explorer system and IDE-style interface.

Do not attempt to run dev unless instructed to do so.  The user usually runs this for you.

We track work in Beads instead of Markdown for internal/local work but use atlassian BST tickets to track project work. Run `bd quickstart` to see how.

## Tools, Skills, Sub-Agents 

- Github: Please use the pr-steward subagent when working with Github related requests
- Mermaid Diagrams: Please the mermaid-diagrams skill
- Documentation Lookup: If you need to reference up-to-date docs use the documentation-lookup-expert, highly encouraged
- delegate reviews code-reviewer agent liberally before creating PRs to save some cycles and catch issues early

## Codanna MCP Tools

Tool priority:
- **Tier 1**: semantic_search_with_context, analyze_impact
- **Tier 2**: find_symbol, get_calls, find_callers
- **Tier 3**: search_symbols, semantic_search_docs, get_index_info

Workflow:
1. semantic_search_with_context - Find relevant code with context
2. analyze_impact - Map dependencies and change radius
3. find_symbol, get_calls, find_callers - Get specific details

Start with semantic search, then narrow with specific queries.


## Development Commands

### Core Development
```bash
# Install dependencies
pnpm install

# Start web application (localhost:8080)
pnpm dev --filter @brainstrike/web

# Start desktop application (Electron)
pnpm dev --filter @brainstrike/desktop
pnpm start --filter @brainstrike/desktop  # Launch Electron after dev server

# Build all packages and applications
pnpm build

# Full validation pipeline (required before commits, note over 10 minutes to run)
pnpm check  # install → lint → build → type-check → test → e2e
```

### Testing & Quality
```bash
# Unit/integration tests across monorepo (jsdom + browser environments)
pnpm test

# Browser-specific tests (Playwright)
pnpm test:browser

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
- **`packages/`**: 30 shared packages with specific purposes

### Key Packages
- **`@brainstrike/ui`**: React components based on shadcn/ui + Radix
- **`@brainstrike/app-shell`**: IDE-style layout system with navigation and panels
- **`@brainstrike/preferences`**: User preferences and settings stores (including model registry)
- **`@brainstrike/db-explorer`**: Database exploration and file import UI
- **`@brainstrike/vector-management`**: Vector/embedding status and queue management
- **`@brainstrike/file-explorer`**: Core file analysis logic (platform-agnostic)
- **`@brainstrike/file-system`**: Abstracted file operations with adapters
- **`@brainstrike/storage`**: Persistent storage with platform adapters
- **`@brainstrike/agent`**: Mastra AI agent integration with streaming support
- **`@brainstrike/embeddings`**: Vector embedding generation with provider factory
- **`@brainstrike/embedding-worker`**: Embedding worker runtime for both web and desktop
- **`@brainstrike/db`**: PGlite database operations with migrations
- **`@brainstrike/queue`**: Job queue infrastructure for embeddings
- **`@brainstrike/types`**: Shared TypeScript definitions
- **`@brainstrike/test-utils`**: Testing utilities and mocks

### Adapter Pattern
Critical architectural pattern enabling cross-platform functionality:
- **File System Adapters**: Node.js, Web API, In-memory (for tests)
- **Storage Adapters**: LocalStorage (web), electron-store (desktop), In-memory (tests)
- Core business logic remains platform-agnostic

## Development Guidelines

### Technology Stack
- **Node.js**: 22+ required (check `.nvmrc`)
- **Package Manager**: pnpm 10.26.2+ with workspaces
- **Build System**: Turborepo 2.7.2 with intelligent caching
- **Frontend**: React 19, Vite 7, TypeScript 5.9
- **Styling**: Tailwind CSS v4 with shared configuration
- **Testing**: Vitest 4 (unit), Playwright (E2E)
- **Linting**: Biome 2.3.8

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


## Documentation & Diagrams

### Mermaid Diagrams
When creating or editing Mermaid diagrams in markdown files:

**CRITICAL**: Manual edits to Mermaid diagrams are highly error-prone. ALWAYS validate after making changes.

1. **After ANY edit to a Mermaid diagram, run the validation script**:
   ```bash
   node .claude/skills/mermaid-diagrams/scripts/validate-mermaid.mjs
   ```

2. **Common Mermaid syntax errors to avoid**:
   - **Parentheses in unquoted labels**: Use `["Label (with parens)"]` NOT `[Label (with parens)]`
   - **Comments in ER diagrams**: Do NOT use `//` comments in `erDiagram` blocks
   - **Line breaks**: Use `<br/>` for line breaks in labels, NOT `\\n` (unless quoted)
   - **Special characters**: Quote labels that contain: `()`, `:`, `,`, `/`, etc.

3. **Node shape syntax**:
   - Rectangle: `[Label]`
   - Rounded: `(Label)`
   - Stadium: `([Label])`
   - Cylinder/Database: `[(Label)]` - Note: this is valid use of parentheses
   - Diamond: `{Label}`

4. **Always test diagrams before committing**. The validation script catches syntax errors that may not be obvious.

See `docs/mermaid-guide.md` for comprehensive Mermaid documentation and best practices.

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

### Turborepo Configuration (v2.7.2)
- Topological builds with dependency awareness
- Shared caching across local and CI environments
- Parallel execution where possible
- Filtered builds: `--filter @brainstrike/web` or `--filter @brainstrike/desktop`

### Validation Pipeline
The `pnpm check` command runs comprehensive validation:
1.  **Dependency Installation**: `pnpm install` ensures all dependencies are correctly installed.
2.  **Linting & Formatting**: `pnpm lint-all` runs the linter and formatter.
3.  **Building**: `pnpm build` builds the entire monorepo.
4.  **Type Checking**: `pnpm type-check` resolves TypeScript errors.
5.  **Unit & Integration Testing**: `pnpm test` runs all unit and integration tests.
6.  **End-to-End Testing**: `pnpm test:e2e` executes Playwright E2E tests.

Always run this before submitting changes.

# TypeScript Standards for Our Project

## Type safety
- strict mode and `noImplicitAny: true` in tsconfig.
- **Never use `any`.** It defeats type checking and hides errors. If a type cannot be inferred, use `unknown` and narrow it with type guards.
- Always annotate function parameters, return types and object literals.

## Utility types and patterns
- Prefer utility types (`Partial`, `Pick`, etc.) over handcrafted `any` patches.
- Use discriminated unions instead of enums for better exhaustiveness checking.
- Use generics with constraints for reusable functions.

Reasoning: Adhering to these guidelines produces code that is safer, easier to refactor and more compatible with our automated testing and linting pipelines.

ALWAYS CONSULT THE WEB FOR BEST PRACTICES WITH THE TECHNOLOGY STACK.

SEARCH FOR THIS YEARS BEST PRACTICES eg 2025 NOT 2024.  

Never downgrade to get something working.

Don't use defensive fallbacks, if something is not working, we need to fail fast and fix it- Do not disable, reward hack or any false workaround, turning something off is not a solution- always do your solutions PROPERLY.
