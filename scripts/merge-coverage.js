#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function main() {
  const outputDir = path.resolve('.nyc_output');
  fs.mkdirSync(outputDir, { recursive: true });
  console.log('Starting coverage file search...');
  const findCommand = "find apps packages -type f -path '*/coverage/*' -name 'coverage-final.json'";
  const result = execSync(findCommand, { encoding: 'utf8' });
  const files = result.split('\n').filter(Boolean);
  console.log('Search completed. Found:', files.length);
  files.forEach(f => console.log(f));

  const merged = {};
  files.forEach(f => {
    if (fs.existsSync(f)) {
      try {
        const content = JSON.parse(fs.readFileSync(f, 'utf8'));
        console.log('Processing file:', f, 'with', Object.keys(content).length, 'entries');
        Object.assign(merged, content);
        console.log('Merged coverage from:', f);
      } catch (e) {
        console.error('Error processing file:', f, e);
      }
    }
  });

  fs.writeFileSync(path.join(outputDir, 'coverage.json'), JSON.stringify(merged));
  console.log(
    'Merged coverage written to',
    path.join(outputDir, 'coverage.json'),
    'with',
    Object.keys(merged).length,
    'total entries'
  );
}

main();
