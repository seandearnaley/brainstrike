#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');

  // Simple logger honoring --quiet
  const info = (...msg) => {
    if (!quiet) {
      console.log(...msg);
    }
  };

  // Determine roots to search for coverage files. Accepts any number of
  // positional directory arguments. If none supplied, default to apps/ and packages/.
  const roots = args.filter((a) => !a.startsWith('-'));
  const searchRoots = roots.length > 0 ? roots : ['apps', 'packages'];

  const outputDir = path.resolve('.nyc_output');
  fs.mkdirSync(outputDir, { recursive: true });

  // Recursively gather coverage-final.json files under the provided roots.
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name === 'coverage-final.json') {
        files.push(p);
      }
    }
  };

  info('Searching coverage under:', searchRoots.join(', '));
  for (const root of searchRoots) {
    walk(path.resolve(root));
  }
  info('Found coverage reports:', files.length);
  if (!files.length) {
    console.error('No coverage-final.json files found. Nothing to merge.');
  }

  // Merge coverage by file path. This is sufficient because each entry
  // is keyed by absolute source path; test runs rarely produce duplicate
  // entries for the same source from different packages.
  const merged = {};
  for (const f of files) {
    try {
      const content = JSON.parse(fs.readFileSync(f, 'utf8'));
      info('Merging', f, `(${Object.keys(content).length} files)`);
      Object.assign(merged, content);
    } catch (e) {
      console.error('Error processing file:', f, e);
    }
  }

  const outFile = path.join(outputDir, 'coverage.json');
  fs.writeFileSync(outFile, JSON.stringify(merged));
  info('Wrote merged coverage to', outFile, 'files:', Object.keys(merged).length);
}

main();
