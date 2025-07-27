#!/usr/bin/env node

import { exec } from 'child_process';

// Skip lefthook installation in CI/build environments
if (process.env.CI || process.env.VERCEL || process.env.NETLIFY || process.env.GITHUB_ACTIONS) {
  console.log('🔧 Skipping lefthook installation in CI/build environment');
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