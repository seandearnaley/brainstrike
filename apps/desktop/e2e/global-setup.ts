import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FullConfig } from '@playwright/test';
import { E2E_CREDENTIAL_ENV_NAMES } from './utils/model-provider-shim';

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

async function globalSetup(_config: FullConfig) {
  verboseLog('🔧 Setting up Electron E2E tests...');
  scrubInheritedProviderCredentials();

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
          '--windows-concurrency=1',
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

  verboseLog('🚀 Electron E2E setup complete');
}

export default globalSetup;
