# BrainStrike Desktop App

A cross-platform desktop application built with Electron, React, and TypeScript, sharing UI components and logic with the web application through a Turborepo monorepo structure.

## Architecture

### Overview
The desktop app consists of two main processes:
- **Main Process** (`src/main.ts`): Node.js environment that manages windows and system APIs
- **Renderer Process** (`src/renderer/`): Chromium-based UI using React, identical to web app

### Key Features
- 🔄 **Shared Components**: Uses the same UI components as the web app via `@brainstrike/*` packages
- 🎨 **Consistent Styling**: TailwindCSS 4 with identical theme and styling
- 💾 **File System Access**: Native file system operations through Electron adapters
- 🗄️ **Local Storage**: Persistent storage using Electron's file-based storage
- 🔧 **Hot Reload**: Development mode with Vite hot reload for renderer
- 📦 **Cross-Platform**: Builds for macOS, Windows, and Linux

## Development

### Prerequisites
- Node.js >= 22
- pnpm (for monorepo workspace management)

### Setup
```bash
# Install dependencies (from monorepo root)
pnpm install

# Navigate to desktop app
cd apps/desktop
```

### Development Commands

#### Start Development Mode
```bash
# Start both renderer dev server and Electron app
npm run dev

# This will:
# 1. Start Vite dev server on port 3001
# 2. Compile main process
# 3. Wait for dev server to be ready
# 4. Launch Electron app
```

#### Individual Commands
```bash
npm run dev:renderer  # Vite dev server on port 3001
npm run dev:main      # Compile main process only
npm run dev:electron  # Compile main + start Electron (requires dev server)
```

#### Build for Production
```bash
# Build both renderer and main process
npm run build

# Or build individually:
npm run build:renderer  # Vite production build
npm run build:main      # TypeScript compilation
```

#### Package & Distribute
```bash
# Create unpacked app in release/ directory
npm run pack

# Create distributable packages (DMG, NSIS, AppImage)
npm run dist
```

### Development Workflow

1. **Start Development**: `npm run dev`
   - Renderer runs on `http://localhost:3001` with hot reload
   - Main process compiles automatically
   - Electron launches when dev server is ready
   - DevTools open automatically in development

2. **Making Changes**: 
   - **Renderer changes**: Reload automatically via Vite hot reload
   - **Main process changes**: Restart Electron (Ctrl+C and `npm run dev` again)

3. **Testing Production Build**: `npm run build && npm start`

## Project Structure

```
apps/desktop/
├── src/
│   ├── main.ts              # Electron main process
│   ├── preload.ts           # Preload script (IPC bridge)
│   └── renderer/            # React renderer app
│       ├── main.tsx         # Renderer entry point
│       ├── styles.css       # Global styles (matches web app)
│       └── components/      # React components
│           ├── root-layout-content.tsx
│           ├── home-page-content.tsx
│           └── settings/
├── public/                  # Static assets
│   └── fonts/inter/         # Inter font files
├── dist/                    # Build output
│   ├── main.js             # Compiled main process
│   ├── preload.js          # Compiled preload script
│   └── renderer/           # Built renderer app
├── release/                 # Packaged applications
├── package.json            # Dependencies & scripts
├── vite.config.mts         # Vite configuration
├── tsconfig.json           # TypeScript configuration
└── tailwind.config.js      # TailwindCSS configuration
```

## Adapters & Platform Integration

### File System Adapter
- **Web**: Uses File System Access API (browser permission-based)
- **Desktop**: Direct Node.js file system access (full system access)

### Storage Adapter  
- **Web**: Uses localStorage/sessionStorage
- **Desktop**: File-based JSON storage in user data directory

### IPC Communication
The preload script exposes secure APIs to the renderer:

```typescript
window.electronAPI = {
  storage: {
    getItem: (key: string) => Promise<string | null>
    setItem: (key: string, value: string) => Promise<void>
    removeItem: (key: string) => Promise<void>
    clear: () => Promise<void>
    getAllKeys: () => Promise<string[]>
  },
  fileSystem: {
    requestDirectoryAccess: () => Promise<DirectoryHandle>
    readDirectory: (handle: DirectoryHandle) => Promise<IFileNode[]>
    readFile: (handle: FileHandle) => Promise<string>
    exists: (path: string) => Promise<boolean>
  }
}
```

Desktop main-process IPC is split by platform responsibility:

- `src/ipc-handlers.ts`: root IPC registration, storage/file-system/database handler wiring, live-query batching, and shutdown cleanup.
- `src/ipc-embedding-backfill.ts`: embedding-host backfill request validation, GPU reclaim configuration, in-flight/cancel state, progress events, and scheduled DB backfill execution.
- `src/ipc-llm-host.ts`, `src/ipc-runtime.ts`, and `src/ipc-chunking-host.ts`: dedicated host/runtime IPC bridges.

Desktop database IPC tests are split by responsibility:

- `src/__tests__/main/ipc-handlers-db.test.ts`: database query/exec, managed cache, live query, reset, diagnostics, and clear-all behavior.
- `src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts`: embedding-host backfill request, progress, cancel, GPU reclaim, and in-flight behavior.
- `src/__tests__/main/ipc-handlers-db-test-fixture.ts`: shared Electron/DB IPC mock fixture.

Focused local verification for the root IPC surface:

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/platform/runtime-host-boundary.test.ts src/__tests__/main/ipc-handlers.test.ts src/__tests__/main/ipc-handlers-errors.test.ts src/__tests__/main/ipc-handlers-fs.test.ts src/__tests__/main/ipc-handlers-folder-restore.test.ts src/__tests__/main/ipc-handlers-db.test.ts src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts
pnpm --filter @brainstrike/desktop type-check
```

## Shared Packages

The desktop app leverages these shared packages from the monorepo:

- `@brainstrike/app-shell`: Application layout and navigation
- `@brainstrike/file-explorer-ui`: File explorer components
- `@brainstrike/file-explorer-hooks`: File explorer state management
- `@brainstrike/file-system`: File system adapters (web/electron)
- `@brainstrike/storage`: Storage adapters (web/electron)
- `@brainstrike/ui`: Shared UI components (buttons, inputs, etc.)
- `@brainstrike/types`: TypeScript type definitions

## Build Configuration

### Electron Builder
Configured for cross-platform distribution:

```json
{
  "appId": "com.brainstrike.desktop",
  "productName": "BrainStrike Desktop",
  "mac": { "target": "dmg" },
  "win": { "target": "nsis" },
  "linux": { "target": "AppImage" }
}
```

### Vite Configuration
- **Development**: Dev server on port 3001
- **Production**: Builds to `dist/renderer/`
- **Assets**: Copies from `public/` directory
- **Plugins**: React, TailwindCSS 4

## Troubleshooting

### Common Issues

1. **Port Conflicts**: Desktop dev server uses port 3001 (web app uses 3000)
2. **Font Loading**: Ensure Inter fonts are in `public/fonts/inter/`
3. **Module Resolution**: Electron adapters require Node.js modules (handled by IPC)
4. **Hot Reload**: Only renderer supports hot reload; main process requires restart
5. **ES Module Issues**: Fixed with proper `import.meta.url` usage for `__dirname`

### Development Issues

**Problem**: `npm run dev` doesn't start Electron
**Solution**: Make sure both processes start:
```bash
# Check if dev server starts
npm run dev:renderer

# In another terminal, check if main compiles
npm run dev:main

# Then try full dev mode
npm run dev
```

**Problem**: "ERR_CONNECTION_REFUSED" when starting Electron
**Solution**: This is normal if dev server isn't running. Use `npm run dev` instead of `npm start` for development.

**Problem**: "__dirname is not defined" error
**Solution**: Fixed in current version using `import.meta.url`

### Debug Mode
```bash
# Start with DevTools open
npm run dev

# Or manually open DevTools in running app
# View > Toggle Developer Tools

# For main process debugging
electron . --inspect=9229
```

### Performance Issues
```bash
# If Electron is slow to start
npm run dev:electron  # Skip renderer and start Electron directly

# If hot reload is slow
# Check if any large files are being watched by Vite
```

## Security

- **Context Isolation**: Enabled (renderer cannot access Node.js directly)
- **Node Integration**: Disabled (secure by default)
- **Preload Script**: Only exposes necessary APIs via `contextBridge`
- **File Access**: Controlled through IPC handlers
- **Sandbox**: Enabled with `--no-sandbox` flag for development compatibility

## Performance

- **Bundle Size**: ~1.5MB compressed (includes React, Monaco Editor)
- **Memory Usage**: ~100-200MB typical
- **Startup Time**: ~2-3 seconds cold start
- **File Operations**: Native performance (no browser limitations)

## Future Enhancements

- [ ] Auto-updater integration
- [ ] Native menu bar integration
- [ ] System tray support
- [ ] Deep linking support
- [ ] Performance monitoring
- [ ] Crash reporting
- [ ] Watch mode for main process development
