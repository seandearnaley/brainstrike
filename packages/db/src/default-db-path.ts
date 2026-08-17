import { getDefaultBrowserPGliteDataDir } from './browser-pglite-storage.js';

type NodeProcessWithBuiltins = NodeJS.Process & {
  getBuiltinModule?: (name: string) => unknown;
};

function getNodeBuiltinModule<TModule>(name: string): TModule {
  const runtimeProcess = globalThis.process as NodeProcessWithBuiltins | undefined;
  const module = runtimeProcess?.getBuiltinModule?.(name);
  if (!module) {
    throw new Error(`Node builtin module is unavailable: ${name}`);
  }
  return module as TModule;
}

// Lazily access Node built-ins without creating static import/require edges in browser bundles.
function requireNodeOs(): { tmpdir: () => string } {
  return getNodeBuiltinModule<{ tmpdir: () => string }>('node:os');
}

function requireNodePath(): { join: (...parts: string[]) => string } {
  return getNodeBuiltinModule<{ join: (...parts: string[]) => string }>('node:path');
}

export function getDefaultDbPath() {
  const isBrowser = typeof window !== 'undefined';
  if (isBrowser) {
    return getDefaultBrowserPGliteDataDir();
  }

  const { tmpdir } = requireNodeOs();
  const { join } = requireNodePath();
  return join(tmpdir(), 'app.db');
}
