# @brainstrike/app-shell

> Production-ready IDE-style layout system for React applications with vector database integration and file management capabilities

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![Node](https://img.shields.io/badge/Node-22+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](../../LICENSE)

## Overview

`@brainstrike/app-shell` provides a comprehensive IDE-style layout system for BrainStrike applications. It delivers a theme-aware, modular application container with advanced features including vector database management, file exploration, and configurable panel layouts.

### Key Features

- 🎨 **IDE-style Layout** - Flexible panel system with resizable sidebar and tools panel
- 🗄️ **Vector Database Integration** - Built-in UI for managing embeddings and vector search
- 📁 **File Management** - Advanced file explorer with import/export capabilities
- 🎯 **Theme Support** - Full light/dark mode with system preference detection
- ⚙️ **Settings Management** - Comprehensive settings page with configuration persistence
- 📊 **Queue Monitoring** - Real-time HUD for background task visualization
- 🔌 **MCP Support** - Model Context Protocol tool-menu integration
- 💾 **State Persistence** - Layout preferences saved across sessions

## Installation

`@brainstrike/app-shell` is distributed as a workspace package. Link it from the
monorepo instead of pulling from a public registry.

```bash
# Add to a specific workspace (example: apps/web)
pnpm add @brainstrike/app-shell --filter @brainstrike/web

# Or wire it directly inside the target package.json
"dependencies": {
  "@brainstrike/app-shell": "workspace:*"
}
```

### Peer Dependencies

Ensure you have the following peer dependencies installed:

Add required peers to the consuming workspace with `pnpm add react react-dom zustand
--filter <workspace>` if they are not already present.

## Assistant Ownership

The app-shell assistant surface owns integration, not model/runtime implementation.

Owned files:

- `src/assistant-ui-panel-wrapper.tsx`: React composition over preferences, DB-backed memory, workspace context, native tools, MCP tools, and the shared UI panel.
- `src/assistant-ui-panel-wrapper-runtime.ts`: Pure helper module for provider/model selection, request data shaping, memory options, MCP/native tool menu shaping, and assistant run-record creation.
- `src/__tests__/assistant-ui-panel-wrapper-test-support.tsx`: Shared wrapper test fixture for provider catalogs, DB mocks, file-explorer stores, MCP bridge setup, and render helpers.

Public surfaces:

- Consumers import `AssistantUiPanelWrapper` through the package root.
- Runtime/provider contracts come from `@brainstrike/assistant-contract`.
- The wrapper must not deep-import `@brainstrike/agent` runtime internals.

Allowed dependencies:

- `@brainstrike/assistant-contract` for provider metadata, local-runtime state, model settings, and memory contracts.
- `@brainstrike/assistant-ui` for presentational assistant UI types/components.
- `@brainstrike/app-state` for persisted user settings and `@brainstrike/settings-ui` for settings presentation.
- `@brainstrike/file-explorer-ui/preview` and `/shell` for workspace context and selection state.

Focused local verification:

```bash
pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/assistant-contract-boundary.test.ts src/__tests__/assistant-ui-panel-wrapper.test.tsx
pnpm --filter @brainstrike/app-shell type-check
```

## Background Indexing Ownership

The app-shell background indexing surface owns orchestration between workspace scans,
managed-cache import, chunking, and embedding backfill. It does not own provider
runtime implementation or embedding execution.

Owned files:

- `src/background-indexing/workspace-collection-sync-service.ts`: orchestration over sync context resolution, access validation, recovery, scan/import/backfill sequencing, and status transitions.
- `src/background-indexing/workspace-collection-sync-import.ts`: file-tree flattening, cache-change preparation, managed-cache mutation batches, and root-folder-cache import execution.
- `src/background-indexing/workspace-collection-sync-progress.ts`: abort helpers, scan status throttling, backfill polling, queue-drained events, and status/progress mapping.
- `src/background-indexing/__tests__/workspace-collection-sync-service.test.ts`: service-level behavior for scan, import, recovery, cancellation, and progress/status transitions.

Public surfaces:

- `WorkspaceCollectionSyncService` and its request/dependency contracts remain the app-shell integration boundary.
- Import/cache helpers stay package-private to `background-indexing`; consumers should not deep-import them.
- Provider model metadata and provider classification flow through `@brainstrike/indexing-contract`.

Allowed dependencies:

- `@brainstrike/indexing-contract` for provider/model-key contracts.
- `@brainstrike/file-explorer-ui/tree` for the public file-tree read surface.
- `@brainstrike/file-explorer-hooks` for file-content processing.
- `@brainstrike/file-import` for enhanced import/chunking orchestration.
- `@brainstrike/db` repository and managed-cache contracts.
- `@brainstrike/app-state` status-store contracts.

Focused local verification:

```bash
pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/indexing-contract-boundary.test.ts src/background-indexing/__tests__/workspace-collection-sync-service.test.ts
pnpm --filter @brainstrike/app-shell type-check
```

## Usage

`AppLayout` accepts the small public `AppShellConfig` contract plus host-owned
routing callbacks and content. Import only exported package surfaces:

```tsx
import { AppLayout, createAppConfig } from '@brainstrike/app-shell';
import '@brainstrike/app-shell/styles.css';
import { Home } from 'lucide-react';

const config = createAppConfig({
  description: 'Workspace',
  navigationItems: [{ icon: Home, name: 'Home', path: '/' }],
  themeStorageKey: 'my-app-theme',
  title: 'My app',
});

export function Shell({ navigate }: { navigate: (path: string) => void }) {
  return (
    <AppLayout
      config={config}
      currentPath="/"
      onNavigationClick={(path) => navigate(path)}
      onOpenSettings={() => navigate('/settings')}
    >
      <main>Application content</main>
    </AppLayout>
  );
}
```

The exact public shape is defined in `src/types.ts`; `src/app-config.tsx` owns
its defaults. Assistant, database, indexing, and platform integrations have
separate ownership contracts above and in `AGENTS.md`—do not infer feature
flags that are absent from `AppShellConfig`.

## Public surface

`src/index.ts` and the `exports` map in `package.json` are authoritative. Use
exported package roots/subpaths; do not copy an export inventory into this
README or deep-import implementation files.

## Development

### Scripts

Run these from `packages/app-shell` (or use the equivalent root
`pnpm --filter @brainstrike/app-shell <script>` form):

```bash
# Development mode with hot reload
pnpm dev

# Build for production
pnpm build

# Run tests
pnpm test

# Type checking
pnpm type-check

# Linting
pnpm lint

# Clean build artifacts
pnpm clean
```

### Testing

```bash
# Run unit tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage report
pnpm test:coverage
```

## Architecture contracts

Read the root `AGENTS.md` routing table and this package's `AGENTS.md` before
changing assistant integration, persistence, indexing, platform bridges, or UI
composition. Those living contracts and their paired tests supersede historical
package inventories and migration notes.

## Contributing

Follow the repository's [coding-agent and contribution policy](../../AGENTS.md)
and open a pull request with the relevant package checks passing.

## License

ISC © BrainStrike

## Support

- 🐛 [Issue Tracker](https://github.com/seandearnaley/brainstrike/issues)
- 💬 [Discussions](https://github.com/seandearnaley/brainstrike/discussions)
---

Built with ❤️ by the BrainStrike team
