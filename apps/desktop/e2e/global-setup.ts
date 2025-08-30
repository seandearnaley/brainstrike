import { exec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FullConfig } from '@playwright/test';

const execAsync = promisify(exec);

async function globalSetup(_config: FullConfig) {
  console.log('🔧 Setting up Electron E2E tests...');

  // Build the Electron app before running tests (skip in CI since it's already built)
  if (!process.env.CI) {
    console.log('📦 Building Electron app...');
    try {
      await execAsync('npm run build', { cwd: process.cwd() });
      console.log('✅ Electron app built successfully');
    } catch (error) {
      console.error('❌ Failed to build Electron app:', error);
      throw error;
    }
  } else {
    console.log('🚀 Skipping build in CI (already built)');
  }

  // Ensure the main process file exists
  const mainPath = path.join(process.cwd(), 'dist', 'main.js');
  const fs = await import('node:fs/promises');

  try {
    await fs.access(mainPath);
    console.log('✅ Main process file found at:', mainPath);
  } catch (_error) {
    console.error('❌ Main process file not found at:', mainPath);
    throw new Error(`Main process file not found. Expected at: ${mainPath}`);
  }

  console.log('🚀 Electron E2E setup complete');
}

export default globalSetup;
