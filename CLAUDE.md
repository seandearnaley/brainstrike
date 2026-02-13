# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BrainStrike is a suite of tools for context management to be used with LLMs. It is a Turborepo monorepo with React 19, Vite, and TypeScript apps+packages. It features both web and desktop versions with a file explorer system and IDE-style interface.

Do not attempt to run dev unless instructed to do so.  The user usually runs this for you.

Always run command line tools non interactively as you are a headless terminal, window popups can block execution.

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `pnpm dlx ultracite fix`
- **Check for issues**: `pnpm dlx ultracite check`
- **Diagnose setup**: `pnpm dlx ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `pnpm dlx ultracite fix` before committing to ensure compliance.


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

SEARCH FOR THIS YEARS BEST PRACTICES eg 2026.  

Never downgrade to get something working.

Don't use defensive fallbacks, if something is not working, we need to fail fast and fix it- Do not disable, reward hack or any false workaround, turning something off is not a solution- always do your solutions PROPERLY.
