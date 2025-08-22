import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { HmrContext, Plugin } from 'vite';
import { isCompilerHotspot } from '../../utils/src/dev/is-compiler-hotspot';

// @ts-ignore: process.env has index signature
const isDev = process.env.NODE_ENV === 'development';

export function findPGliteWasm(baseDir: string): string | null {
  const possiblePaths = [
    path.resolve(baseDir, '../../node_modules/@electric-sql/pglite/dist/pglite.wasm'),
    path.resolve(baseDir, 'node_modules/@electric-sql/pglite/dist/pglite.wasm'),
  ];

  try {
    const pnpmDir = path.resolve(baseDir, '../../node_modules/.pnpm');
    if (existsSync(pnpmDir)) {
      const entries = readdirSync(pnpmDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('@electric-sql+pglite@')) {
          const wasmPath = path.join(
            pnpmDir,
            entry.name,
            'node_modules/@electric-sql/pglite/dist/pglite.wasm'
          );
          possiblePaths.push(wasmPath);
        }
      }
    }
  } catch {
    // ignore errors when scanning pnpm directory
  }

  for (const wasmPath of possiblePaths) {
    if (existsSync(wasmPath)) {
      if (isDev) {
        console.log(`Found PGLite WASM at: ${wasmPath}`);
      }
      return wasmPath;
    }
  }

  console.warn('PGLite WASM file not found in any expected location');
  return null;
}

export function fullReloadOnCompilerHotspots(): Plugin {
  return {
    name: 'full-reload-on-compiler-hotspots',
    handleHotUpdate(ctx: HmrContext) {
      if (isCompilerHotspot(ctx.file)) {
        ctx.server.ws.send({ type: 'full-reload' });
        return [];
      }
      return undefined;
    },
  };
}
