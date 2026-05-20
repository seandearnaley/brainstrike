# @brainstrike/app-shell

> Production-ready IDE-style layout system for React applications with vector database integration and file management capabilities

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![Node](https://img.shields.io/badge/Node-22+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)

## Overview

`@brainstrike/app-shell` provides a comprehensive IDE-style layout system for BrainStrike applications. It delivers a theme-aware, modular application container with advanced features including vector database management, file exploration, and configurable panel layouts.

### Key Features

- 🎨 **IDE-style Layout** - Flexible panel system with resizable sidebar and tools panel
- 🗄️ **Vector Database Integration** - Built-in UI for managing embeddings and vector search
- 📁 **File Management** - Advanced file explorer with import/export capabilities
- 🎯 **Theme Support** - Full light/dark mode with system preference detection
- ⚙️ **Settings Management** - Comprehensive settings page with configuration persistence
- 📊 **Queue Monitoring** - Real-time HUD for background task visualization
- 🔌 **MCP Support** - Model Context Protocol banner integration
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

Add required peers to the consuming workspace with `pnpm add react zustand
--filter <workspace>` if they are not already present.

### Development Notes

- `@brainstrike/db` is intentionally a devDependency in app-shell because it is only used in tests.
  Runtime access flows through `@brainstrike/db-explorer`.

## Assistant Ownership

The app-shell assistant surface owns integration, not model/runtime implementation.

Owned files:

- `src/assistant-ui-panel-wrapper.tsx`: React composition over preferences, DB-backed memory, workspace context, native tools, MCP tools, and the shared UI panel.
- `src/assistant-ui-panel-wrapper-runtime.ts`: Pure helper module for provider/model selection, request data shaping, memory options, MCP/native tool menu shaping, and assistant run-record creation.
- `src/assistant-thread-store.ts`: Per-thread draft runtime state.
- `src/assistant-memory-repository.ts`: PGlite-backed thread and run-record persistence.

Public surfaces:

- Consumers import `AssistantUiPanelWrapper` through the package root.
- Runtime/provider contracts come from `@brainstrike/assistant-contract`.
- The wrapper must not deep-import `@brainstrike/agent` runtime internals.

Allowed dependencies:

- `@brainstrike/assistant-contract` for provider metadata, local-runtime state, model settings, and memory contracts.
- `@brainstrike/ui/assistant-ui-panel` for presentational assistant UI types/components.
- `@brainstrike/preferences` for persisted user settings.
- `@brainstrike/file-explorer-ui/preview` and `/shell` for workspace context and selection state.

Focused local verification:

```bash
pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/assistant-contract-boundary.test.ts src/__tests__/assistant-ui-panel-wrapper.test.tsx
pnpm --filter @brainstrike/app-shell type-check
```

## Usage

### Basic Setup

```tsx
import { AppLayout, createAppConfig } from "@brainstrike/app-shell";
import "@brainstrike/app-shell/styles.css"; // Import styles

const config = createAppConfig({
  navigationItems: [
    { title: "Dashboard", href: "/", icon: "home" },
    { title: "Files", href: "/files", icon: "folder" },
    { title: "Settings", href: "/settings", icon: "settings" }
  ],
  theme: "system", // "light" | "dark" | "system"
  enableVectorDB: true,
  enableFileExplorer: true
});

function MyApp({ children }: { children: React.ReactNode }) {
  return (
    <AppLayout config={config} currentPath={location.pathname}>
      {children}
    </AppLayout>
  );
}
```

### Advanced Configuration

```tsx
import {
  AppLayout,
  createAppConfig,
  RootLayoutContent,
  PageWrapper,
  usePanelLayoutStore
} from "@brainstrike/app-shell";

const config = createAppConfig({
  navigationItems: [
    { title: "Home", href: "/", icon: "home", badge: "3" },
    { title: "Projects", href: "/projects", icon: "folder-open" },
    {
      title: "Database",
      href: "/database",
      icon: "database",
      disabled: false
    }
  ],
  theme: "dark",
  enableVectorDB: true,
  enableFileExplorer: true,
  enableQueueHUD: true,
  enableMCPBanner: true,
  panelDefaults: {
    leftPanelOpen: true,
    rightPanelOpen: false,
    leftPanelSize: 260,
    rightPanelSize: 400
  }
});

function App() {
  const { toggleLeftPanel, toggleRightPanel } = usePanelLayoutStore();

  return (
    <RootLayoutContent config={config}>
      <PageWrapper title="Dashboard" description="Main application view">
        {/* Your page content */}
      </PageWrapper>
    </RootLayoutContent>
  );
}
```

## Components

### Core Layout Components

#### `AppLayout`
Main application container providing the IDE-style layout structure.

```tsx
<AppLayout config={config} currentPath="/dashboard">
  {children}
</AppLayout>
```

#### `RootLayoutContent`
Root layout wrapper with theme and panel management.

```tsx
<RootLayoutContent config={config}>
  {children}
</RootLayoutContent>
```

#### `PageWrapper`
Page container with title and breadcrumb support.

```tsx
<PageWrapper
  title="Page Title"
  description="Optional description"
  breadcrumbs={[
    { label: "Home", href: "/" },
    { label: "Current Page" }
  ]}
>
  {content}
</PageWrapper>
```

### Feature Components

#### `DatabaseDemoPanel`
Complete vector database management interface (re-exported from `@brainstrike/db-explorer`).

```tsx
import { DatabaseDemoPanel } from "@brainstrike/app-shell";
// Or import directly from:
// import { DatabaseDemoPanel } from "@brainstrike/db-explorer";

<DatabaseDemoPanel
  onClose={() => setShowPanel(false)}
  initialView="search"
/>
```

#### `VectorStatus`
Real-time vector database status indicator (re-exported from `@brainstrike/vector-management`).

```tsx
import { VectorStatus } from "@brainstrike/app-shell";
// Or import directly from:
// import { VectorStatus } from "@brainstrike/vector-management";

<VectorStatus
  showDetails={true}
  refreshInterval={5000}
/>
```

#### `QueueHUD`
Background task monitoring overlay (re-exported from `@brainstrike/vector-management`).

```tsx
import { QueueHUD } from "@brainstrike/app-shell";
// Or import directly from:
// import { QueueHUD } from "@brainstrike/vector-management";

<QueueHUD
  position="bottom-right"
  maxItems={5}
/>
```

## State Management

### Panel Layout Store

Panel layout state (sizes, visibility, active tab) is managed by `@brainstrike/preferences`:

```tsx
import { usePanelLayoutStore } from "@brainstrike/preferences";

function MyComponent() {
  const activeTab = usePanelLayoutStore((s) => s.activeTab);
  const showLeftPanel = usePanelLayoutStore((s) => s.showLeftPanel);
  const toggleLeft = usePanelLayoutStore((s) => s.toggleLeft);

  // Use store values and actions
}
```

### Settings

Settings page content (`SettingsPageContent`, `LoggingSettingsSection`) lives in `@brainstrike/preferences`.
Import directly from that package rather than from app-shell.

## Utilities

### CSV Export

Export data to CSV format with proper formatting:

```tsx
import { exportToCSV, formatCSVValue } from "@brainstrike/app-shell";

const data = [
  { id: 1, name: "Item 1", value: 100 },
  { id: 2, name: "Item 2", value: 200 }
];

exportToCSV(data, "export.csv");
```

## Styling

The package includes pre-built styles that integrate with your application's Tailwind configuration:

```css
/* Import in your global CSS or main component */
@import "@brainstrike/app-shell/styles.css";
```

### Theme Variables

Customize appearance using CSS variables:

```css
:root {
  --app-shell-sidebar-width: 260px;
  --app-shell-panel-width: 400px;
  --app-shell-header-height: 64px;
  --app-shell-border-radius: 8px;
}
```

## TypeScript Support

Full TypeScript support with exported types:

```tsx
import type {
  AppConfig,
  NavigationItem,
  PanelLayoutState,
  DatabaseView,
  ExportFormat
} from "@brainstrike/app-shell";
```

## Development

### Scripts

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

## Architecture

### Package Dependencies

This package integrates with other BrainStrike packages:

- `@brainstrike/ui` - UI component library
- `@brainstrike/preferences` - User preferences and settings stores
- `@brainstrike/db-explorer` - Database exploration and file import UI
- `@brainstrike/vector-management` - Vector/embedding status and queue management
- `@brainstrike/file-explorer-ui` - File explorer components
- `@brainstrike/file-explorer-hooks` - File explorer hooks
- `@brainstrike/storage` - Persistent storage adapters
- `@brainstrike/agent` - Mastra AI agent integration
- `@brainstrike/utils` - Common utilities
- `@brainstrike/types` - Shared TypeScript definitions

### File Structure

```
src/
├── components/           # React components
│   ├── app-layout.tsx
│   ├── navigation.tsx
│   └── ...
├── database-demo/        # Database UI module
│   ├── components/
│   ├── hooks/
│   └── types/
├── stores/              # Zustand stores (layout moved to @brainstrike/preferences)
├── types/               # TypeScript definitions
└── index.ts            # Public exports
```

## Browser Support

- Chrome/Edge 120+
- Firefox 115+
- Safari 17+
- Requires ES2022+ support

## Performance Considerations

- Layout calculations are memoized for optimal rendering
- Panel resize operations use RAF for smooth animations
- Database queries implement virtual scrolling for large datasets
- File operations use web workers when available

## Migration Guide

### From v0.0.x to v0.1.0

```tsx
// Old API
import { AppContainer } from "@brainstrike/app-shell";

// New API
import { AppLayout } from "@brainstrike/app-shell";

// Configuration changes
const config = createAppConfig({
  // New required fields
  enableVectorDB: true,
  enableFileExplorer: true,
  // Panel configuration moved to panelDefaults
  panelDefaults: {
    leftPanelOpen: true,
    rightPanelOpen: false
  }
});
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](../../CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## License

ISC © BrainStrike

## Support

- 📖 [Documentation](https://brainstrike.dev/docs/app-shell)
- 🐛 [Issue Tracker](https://github.com/brainstrike/brainstrike/issues)
- 💬 [Discussions](https://github.com/brainstrike/brainstrike/discussions)

---

Built with ❤️ by the BrainStrike team
