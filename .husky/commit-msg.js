#!/usr/bin/env node

const { execSync } = require('child_process');

try {
  execSync(`npx --no -- commitlint --edit ${process.argv[2]}`, { stdio: 'inherit' });
} catch (error) {
  process.exit(1);
}
