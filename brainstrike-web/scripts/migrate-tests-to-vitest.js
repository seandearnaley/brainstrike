#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Common replacements for Jest to Vitest migration
const REPLACEMENTS = [
  {
    from: /import \{([^}]*)\} from ['"]@jest\/globals['"]/g,
    to: "import { $1 } from 'vitest'"
  },
  {
    from: /import \{([^}]*)\} from ['"]jest['"]/g,
    to: "import { $1 } from 'vitest'"
  },
  {
    from: /jest\.useFakeTimers\(\)/g,
    to: 'vi.useFakeTimers()'
  },
  {
    from: /jest\.useRealTimers\(\)/g,
    to: 'vi.useRealTimers()'
  },
  {
    from: /jest\.spyOn/g,
    to: 'vi.spyOn'
  },
  {
    from: /jest\.fn/g,
    to: 'vi.fn'
  },
  {
    from: /jest\.mock/g,
    to: 'vi.mock'
  },
  {
    from: /jest\.resetModules/g,
    to: 'vi.resetModules'
  },
  {
    from: /jest\.advanceTimersByTime/g,
    to: 'vi.advanceTimersByTime'
  },
  {
    from: /jest\.runAllTimers/g,
    to: 'vi.runAllTimers'
  },
  {
    from: /jest\.runOnlyPendingTimers/g,
    to: 'vi.runOnlyPendingTimers'
  },
  // Add vitest imports if not present
  {
    from: /^(import[^;]*@testing-library\/react[^;]*;)(?!\s*import[^;]*vitest)/m,
    to: "$1\nimport { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';"
  }
];

function findTestFiles(dir) {
  const testFiles = [];
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      if (file === '__tests__' || file.endsWith('.test') || file.endsWith('.spec')) {
        // If it's a test directory, add all test files
        const subFiles = fs.readdirSync(filePath);
        testFiles.push(...subFiles
          .filter(f => f.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/))
          .map(f => path.join(filePath, f)));
      } else {
        // Recursively search other directories
        testFiles.push(...findTestFiles(filePath));
      }
    } else if (file.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/)) {
      testFiles.push(filePath);
    }
  }

  return testFiles;
}

function migrateFile(filePath) {
  console.log(`Migrating ${filePath}...`);
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  for (const replacement of REPLACEMENTS) {
    const newContent = content.replace(replacement.from, replacement.to);
    if (newContent !== content) {
      content = newContent;
      modified = true;
    }
  }

  if (modified) {
    // Create a backup
    const backupPath = `${filePath}.jest-backup`;
    fs.writeFileSync(backupPath, fs.readFileSync(filePath));
    console.log(`Created backup at ${backupPath}`);

    // Write the modified content
    fs.writeFileSync(filePath, content);
    console.log(`Updated ${filePath}`);

    // Try to format the file with Biome if available
    try {
      execSync(`npx biome format --write "${filePath}"`, { stdio: 'ignore' });
      console.log(`Formatted ${filePath} with Biome`);
    } catch (error) {
      console.log(`Note: Biome formatting skipped for ${filePath}`);
    }
  } else {
    console.log(`No changes needed for ${filePath}`);
  }
}

// Main execution
const srcDir = path.join(process.cwd(), 'src');
const testFiles = findTestFiles(srcDir);

console.log(`Found ${testFiles.length} test files to process`);
console.log('\nStarting migration...\n');

for (const file of testFiles) {
  migrateFile(file);
}

console.log('\nMigration complete!');
console.log('\nNext steps:');
console.log('1. Run "npm run test" to check for any issues');
console.log('2. Review the changes in each file');
console.log('3. Delete the .jest-backup files once verified');
console.log('\nNote: Some manual updates may still be needed for complex cases.'); 