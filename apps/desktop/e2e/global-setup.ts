import { exec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FullConfig } from '@playwright/test';

// Ensure proper typing for process in E2E context
declare const process: NodeJS.Process;

const execAsync = promisify(exec);

async function globalSetup(_config: FullConfig) {
  console.log('🔧 Setting up Electron E2E tests...');

  // Build the Electron app before running tests.
  // In CI, ensure renderer assets exist; if missing, build renderer.
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
    console.log('🚀 Skipping full build in CI (main is prebuilt)');
  }

  // Ensure the main process file exists
  const mainPath = path.join(process.cwd(), 'dist', 'main.js');
  const fs = await import('node:fs/promises');

  try {
    await fs.access(mainPath);
    console.log('✅ Main process file found at:', mainPath);
  } catch (error) {
    console.error('❌ Main process file not found at:', mainPath);
    throw new Error(`Main process file not found. Expected at: ${mainPath}`);
  }

  // Ensure renderer index exists; if missing in CI, build renderer only.
  const rendererIndex = path.join(process.cwd(), 'dist', 'renderer', 'index.html');
  try {
    await fs.access(rendererIndex);
    console.log('✅ Renderer index file found at:', rendererIndex);
  } catch {
    console.warn('⚠️ Renderer index not found at:', rendererIndex);
    if (process.env.CI) {
      console.log('📦 Building renderer (CI fallback)...');
      try {
        await execAsync('npm run build:renderer', { cwd: process.cwd() });
        console.log('✅ Renderer built successfully');
      } catch (error) {
        console.error('❌ Failed to build renderer in CI:', error);
        throw error;
      }
    } else {
      console.log('ℹ️ Not in CI; full build should have produced renderer assets');
    }
  }

  console.log('🚀 Electron E2E setup complete');
}

export default globalSetup;
