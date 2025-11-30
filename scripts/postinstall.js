#!/usr/bin/env node

import { exec } from 'child_process';

// Skip lefthook installation in CI/build environments or when explicitly opted out
const skipByEnv =
  process.env.CI ||
  process.env.VERCEL ||
  process.env.NETLIFY ||
  process.env.GITHUB_ACTIONS ||
  process.env.SKIP_GIT_HOOKS === '1' ||
  process.env.SKIP_LEFTHOOK_INSTALL === '1';

if (skipByEnv) {
  console.log('🔧 Skipping lefthook installation (CI/build or SKIP_* flag set)');
  process.exit(0);
}

// Install lefthook in development environments
console.log('🔧 Installing lefthook git hooks...');
exec('pnpm exec lefthook install', (error, stdout, stderr) => {
  if (error) {
    console.warn(`⚠️  Lefthook installation failed: ${error.message}`);
    console.warn('This is not critical - git hooks will not be available');
    return;
  }

  if (stderr) {
    console.warn(`⚠️  Lefthook warning: ${stderr}`);
  }

  if (stdout) {
    console.log(`✅ ${stdout.trim()}`);
  }

  console.log('✅ Lefthook git hooks installed successfully');
});
