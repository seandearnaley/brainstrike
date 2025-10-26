#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { glob } from 'glob';
import mermaid from 'mermaid';

const files = await glob('docs/architecture/*.md');

let hasErrors = false;

for (const file of files) {
  const content = await readFile(file, 'utf-8');
  const mermaidBlocks = content.match(/```mermaid\n([\s\S]*?)\n```/g);

  if (!mermaidBlocks) {
    console.log(`✓ ${file}: No Mermaid diagrams`);
    continue;
  }

  console.log(`\nChecking ${file}...`);

  for (let i = 0; i < mermaidBlocks.length; i++) {
    const diagram = mermaidBlocks[i].replace(/```mermaid\n/, '').replace(/\n```$/, '');

    try {
      // Try to parse the diagram
      await mermaid.parse(diagram);
      console.log(`  ✓ Diagram ${i + 1}: Valid`);
    } catch (error) {
      console.error(`  ✗ Diagram ${i + 1}: ERROR`);
      console.error(`    ${error.message}`);
      console.error(`    Diagram preview:`);
      console.error(diagram.split('\n').slice(0, 5).map(l => `      ${l}`).join('\n'));
      hasErrors = true;
    }
  }
}

if (hasErrors) {
  console.error('\n❌ Validation failed with errors');
  process.exit(1);
} else {
  console.log('\n✅ All Mermaid diagrams are valid');
}
