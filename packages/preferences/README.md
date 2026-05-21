# @brainstrike/preferences

> Centralized user preferences and settings management for BrainStrike applications

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![Node](https://img.shields.io/badge/Node-22+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)

## Overview

`@brainstrike/preferences` provides a unified preferences system for BrainStrike applications. It manages all user settings and configuration using Zustand stores with automatic persistence, ensuring consistent behavior across desktop and web platforms.

### Key Features

- 🔧 **Unified Settings** - Single source of truth for all user preferences
- 💾 **Auto Persistence** - Settings automatically saved to localStorage or fallback storage
- 🎨 **Theme Management** - Appearance preferences with system detection
- 🤖 **AI Configuration** - Provider and model selection for assistant features
- 📊 **Vector Preferences** - Embedding and vector database settings
- 📁 **Import Settings** - File import and chunking configuration
- 📝 **Logging Preferences** - Runtime-aware logging configuration
- 🔄 **Panel Layout** - UI panel state management

## Installation

`@brainstrike/preferences` is distributed as a workspace package within the BrainStrike monorepo.

```bash
# Add to a specific workspace
pnpm add @brainstrike/preferences --filter @brainstrike/web

# Or add directly to package.json
"dependencies": {
  "@brainstrike/preferences": "workspace:*"
}
```

## Usage

### Assistant Preferences

Manage AI provider and model selection:

```typescript
import { useAssistantPreferencesStore } from '@brainstrike/preferences';

function AssistantSettings() {
  const {
    selectedProvider,
    setProvider,
    getSelectedModel,
    modelsByProvider,
    setModelForProvider
  } = useAssistantPreferencesStore();

  return (
    <div>
      <select value={selectedProvider || ''} onChange={(e) => setProvider(e.target.value)}>
        <option value="anthropic">Anthropic</option>
        <option value="openai">OpenAI</option>
      </select>
      <p>Selected Model: {getSelectedModel()}</p>
    </div>
  );
}
```

### Vector Preferences

Configure embedding and vector database settings:

```typescript
import { useVectorPreferencesStore } from '@brainstrike/preferences';

function VectorSettings() {
  const {
    devicePref,
    setDevicePref,
    reinitEveryN,
    setReinitEveryN
  } = useVectorPreferencesStore();

  return (
    <div>
      <select
        value={devicePref}
        onChange={(e) => setDevicePref(e.target.value as 'webgpu' | 'wasm')}
      >
        <option value="webgpu">WebGPU</option>
        <option value="wasm">WASM</option>
      </select>
      <input
        type="number"
        value={reinitEveryN}
        onChange={(e) => setReinitEveryN(Number(e.target.value))}
      />
    </div>
  );
}
```

### Import Settings

Manage file import and chunking configuration:

```typescript
import { useImportSettingsStore } from '@brainstrike/preferences';

function ImportSettings() {
  const {
    enableChunking,
    setEnableChunking,
    chunkSize,
    setChunkSize,
    chunkOverlap,
    setChunkOverlap,
    enableEmbedding,
    setEnableEmbedding
  } = useImportSettingsStore();

  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={enableChunking}
          onChange={(e) => setEnableChunking(e.target.checked)}
        />
        Enable Chunking
      </label>
      {enableChunking && (
        <>
          <input
            type="number"
            value={chunkSize}
            onChange={(e) => setChunkSize(Number(e.target.value))}
            placeholder="Chunk Size"
          />
          <input
            type="number"
            value={chunkOverlap}
            onChange={(e) => setChunkOverlap(Number(e.target.value))}
            placeholder="Overlap"
          />
        </>
      )}
    </div>
  );
}
```

### Logging Preferences

Configure logging output and runtime settings:

```typescript
import { useLoggingPreferencesStore } from '@brainstrike/preferences';

function LoggingSettings() {
  const {
    enableFileOutput,
    setEnableFileOutput,
    logFilePath,
    setLogFilePath,
    logLevel,
    setLogLevel
  } = useLoggingPreferencesStore();

  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={enableFileOutput}
          onChange={(e) => setEnableFileOutput(e.target.checked)}
        />
        Enable File Output
      </label>
      {enableFileOutput && (
        <input
          type="text"
          value={logFilePath}
          onChange={(e) => setLogFilePath(e.target.value)}
          placeholder="Log file path"
        />
      )}
      <select value={logLevel} onChange={(e) => setLogLevel(e.target.value)}>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>
    </div>
  );
}
```

### Panel Layout

Manage UI panel state:

```typescript
import { usePanelLayoutStore } from '@brainstrike/preferences';

function LayoutControls() {
  const {
    leftPanelOpen,
    rightPanelOpen,
    toggleLeftPanel,
    toggleRightPanel,
    leftPanelSize,
    setLeftPanelSize
  } = usePanelLayoutStore();

  return (
    <div>
      <button onClick={toggleLeftPanel}>
        {leftPanelOpen ? 'Hide' : 'Show'} Left Panel
      </button>
      <button onClick={toggleRightPanel}>
        {rightPanelOpen ? 'Hide' : 'Show'} Right Panel
      </button>
    </div>
  );
}
```

## UI Components

### LoggingSettingsSection

Pre-built settings UI for logging preferences:

```typescript
import { LoggingSettingsSection } from '@brainstrike/preferences';

function SettingsPage() {
  return (
    <div>
      <h2>Logging Settings</h2>
      <LoggingSettingsSection />
    </div>
  );
}
```

### SettingsPageContent

Master-detail settings page layout:

```typescript
import {
  SettingsPageContent,
  createAppearanceSettingsCategory
} from '@brainstrike/preferences';
import { Key } from 'lucide-react';

const categories = [
  createAppearanceSettingsCategory(),
  {
    id: 'account',
    title: 'Account',
    description: 'Manage authentication settings',
    keywords: ['auth', 'security'],
    icon: Key,
    render: () => <AccountSettings />
  }
];

<SettingsPageContent categories={categories} defaultCategoryId="appearance" />
```

## Architecture

### Stores

All stores use Zustand with persistence middleware:

- **assistant-preferences-store** - AI provider/model selection
- **vector-preferences-store** - Embedding/vector database settings
- **import-settings-store** - File import configuration
- **logging-preferences-store** - Logging configuration
- **panel-layout-store** - UI panel state

### Persistence

Settings are automatically persisted to:
1. **localStorage** (primary) - For web and desktop
2. **In-memory fallback** - When localStorage is unavailable

### Storage Keys

Each store uses a unique localStorage key:
- `brainstrike:assistant-prefs`
- `brainstrike:vector-prefs`
- `brainstrike:import-settings`
- `brainstrike:logging-prefs`
- `brainstrike:panel-layout`

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import type {
  AssistantPreferencesState,
  VectorPreferencesState,
  ImportSettingsState,
  LoggingPreferencesState,
  PanelLayoutState,
  SupportedProvider,
  DevicePreference,
  ChunkStrategy
} from '@brainstrike/preferences';
```

## Dependencies

- `@brainstrike/assistant-contract` - Assistant-facing settings contracts
- `@brainstrike/db` - Database operations
- `@brainstrike/indexing-contract` - Embedding model metadata contracts
- `@brainstrike/storage` - Storage adapters
- `@brainstrike/ui` - UI components
- `@brainstrike/utils` - Common utilities
- `zustand` (peer) - State management
- `react` (peer) - UI framework

## Development

```bash
# Build
pnpm build

# Tests
pnpm test

# Type checking
pnpm type-check

# Linting
pnpm lint
```

## License

ISC © BrainStrike
