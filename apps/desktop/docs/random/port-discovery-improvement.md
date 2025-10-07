# Port Discovery Improvement

## Current Issue

The desktop app currently scans fixed ports (8081-8083) in `create-window.ts`:

```typescript
const devPorts = [8081, 8082, 8083]; // Port 8080 is reserved for the web app
```

This approach is brittle when multiple local instances run, causing "address in use" errors.

## Proposed Solution

### 1. Use Vite's Dynamic Port Assignment

Modify the dev script to use `--port 0` for automatic port selection:

```json
{
  "scripts": {
    "dev:renderer": "vite --port 0"
  }
}
```

### 2. Port Communication via IPC

Have the renderer process communicate its port back to the main process:

```typescript
// In renderer startup
const port = window.location.port;
window.electronAPI?.send('renderer-port', port);

// In main process
ipcMain.handle('renderer-port', (event, port) => {
  console.log(`Renderer running on port ${port}`);
  // Store for future reference
});
```

### 3. Alternative: Environment Variable

Pass the port via environment variable:

```bash
VITE_PORT=$(vite --port 0 2>&1 | grep -o 'localhost:[0-9]*' | cut -d: -f2)
```

## Implementation Priority

This is marked as low priority because:
- Current port scanning works reliably in most scenarios
- The error case (multiple instances) is less common in typical development
- Implementation requires coordinated changes across build system and IPC layer

## Benefits When Implemented

- Eliminates "address in use" conflicts
- More robust local development experience
- Supports unlimited parallel dev instances
- Aligns with modern development practices