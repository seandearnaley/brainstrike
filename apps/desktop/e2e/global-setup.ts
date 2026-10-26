import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FullConfig } from '@playwright/test';
import { createServer } from 'vite';
import { resolveDesktopE2eTarget } from './utils/desktop-e2e-target';
import { E2E_CREDENTIAL_ENV_NAMES } from './utils/model-provider-shim';
import { E2E_VITE_CACHE_DIR_ENV } from './utils/run-vite-cache';

const execFileAsync = promisify(execFile);
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const isVerboseE2eLoggingEnabled = process.env['BRAINSTRIKE_E2E_VERBOSE'] === '1';

function verboseLog(...args: unknown[]): void {
  if (!isVerboseE2eLoggingEnabled) {
    return;
  }
  console.log(...args);
}

/**
 * Removes every provider credential the runner inherited (BST-1931). Workers
 * are spawned after global setup, so a developer's real shell keys never reach
 * an E2E app; fixture keys a spec sets later in its worker are unaffected.
 */
function scrubInheritedProviderCredentials(): void {
  for (const name of Object.keys(process.env)) {
    if (E2E_CREDENTIAL_ENV_NAMES.has(name.toUpperCase())) {
      delete process.env[name];
      verboseLog(`🔒 Removed inherited provider credential ${name}`);
    }
  }
}

/**
 * Optimizes the dev renderer's dependencies once for the run, before any worker starts, into a
 * run-level cache that dev-server specs read without optimizing again (`run-vite-cache.ts`).
 * The directory is named `.vite` so the React transform keeps excluding its chunks. Returns
 * the cache's removal.
 */
async function optimizeRunViteCache(): Promise<() => Promise<void>> {
  const directory = await mkdtemp(path.join(tmpdir(), 'bs-e2e-vite-'));
  const cacheDir = path.join(directory, '.vite');
  const server = await createServer({
    cacheDir,
    configFile: path.join(appRoot, 'vite.config.mts'),
    optimizeDeps: { force: true, holdUntilCrawlEnd: false },
    root: appRoot,
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const optimizer = server.environments.client.depsOptimizer;
    if (!optimizer) {
      throw new Error('The dev renderer has no dependency optimizer');
    }
    await optimizer.scanProcessing;
    await Promise.all(
      Object.values(optimizer.metadata.discovered).map((dependency) => dependency.processing)
    );
  } finally {
    await server.close();
  }
  // The optimizer commits its metadata last; without it every dev-server spec would optimize.
  await access(path.join(cacheDir, 'deps', '_metadata.json'));
  process.env[E2E_VITE_CACHE_DIR_ENV] = cacheDir;
  console.log(`Dev renderer dependencies optimized once for this run into ${cacheDir}`);
  return () => rm(directory, { force: true, recursive: true });
}

async function globalSetup(_config: FullConfig) {
  verboseLog('🔧 Setting up Electron E2E tests...');
  scrubInheritedProviderCredentials();

  // BST-2190: a packaged run qualifies the electron-builder output as it is, so
  // it neither builds nor reads `dist/`; a missing executable fails here, before
  // any spec starts.
  const target = resolveDesktopE2eTarget();
  if (target.kind === 'packaged') {
    console.log(`🚀 Desktop E2E launches the packaged app: ${target.executablePath}`);
    return;
  }

  // Build the Electron app before running tests (skip in CI since it's already built)
  if (process.env['CI']) {
    verboseLog('🚀 Skipping build in CI (already built)');
  } else {
    verboseLog('📦 Building Electron app...');
    try {
      // Use the same source/dependency hashes and artifact cache as `pnpm check`.
      // Direct `pnpm build` reran Vite and esbuild for every local lane.
      await execFileAsync(
        process.execPath,
        [
          path.resolve(appRoot, '../../scripts/run-turbo-command.mjs'),
          '--',
          'run',
          'build',
          '--filter=@brainstrike/desktop',
        ],
        { cwd: appRoot }
      );
      verboseLog('✅ Electron app built successfully');
    } catch (error) {
      console.error('❌ Failed to build Electron app:', error);
      throw error;
    }
  }

  // Ensure the main process file exists
  const mainPath = path.join(appRoot, 'dist', 'main.js');
  const rendererPath = path.join(appRoot, 'dist', 'renderer', 'index.html');
  const fs = await import('node:fs/promises');

  try {
    await fs.access(mainPath);
    verboseLog('✅ Main process file found at:', mainPath);
  } catch {
    console.error('❌ Main process file not found at:', mainPath);
    throw new Error(`Main process file not found. Expected at: ${mainPath}`);
  }

  try {
    await fs.access(rendererPath);
    verboseLog('✅ Renderer entry point found at:', rendererPath);
  } catch {
    console.error('❌ Renderer entry point not found at:', rendererPath);
    throw new Error(`Renderer entry point not found. Expected at: ${rendererPath}`);
  }

  const removeViteCache = await optimizeRunViteCache();
  verboseLog('🚀 Electron E2E setup complete');
  return removeViteCache;
}

export default globalSetup;
