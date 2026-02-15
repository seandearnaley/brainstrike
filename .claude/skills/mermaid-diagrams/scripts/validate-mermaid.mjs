#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { glob } from 'glob';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const files = await glob('apps/docs/docs/architecture/*.md');

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

    // Basic syntax validation - check for common errors
    const errors = [];

    // Check for unmatched parentheses in labels (common error)
    const lines = diagram.split('\n');
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum].trim();

      // Skip empty lines and comments
      if (!line || line.startsWith('%%')) continue;

      // Check for parentheses outside of quoted strings in node definitions
      // But skip cylinder/database nodes which use [(  and  )] syntax
      const nodeDefMatch = line.match(/^\s*\w+\[(.*)\]/);
      if (nodeDefMatch) {
        const label = nodeDefMatch[1];
        // Skip if it's a cylinder/database node: [(...)]
        const isCylinderNode = label.startsWith('(') && label.endsWith(')');
        // If label contains ( or ) and is not quoted and not a cylinder node, it's likely an error
        if (!isCylinderNode && (label.includes('(') || label.includes(')')) && !label.startsWith('"') && !label.startsWith("'")) {
          errors.push(`Line ${lineNum + 1}: Parentheses in unquoted label: ${line}`);
        }
      }

      // Check for // comments in ER diagrams (not allowed)
      if (diagram.includes('erDiagram') && line.includes('//')) {
        errors.push(`Line ${lineNum + 1}: Comments not allowed in ER diagrams: ${line}`);
      }
    }

    if (errors.length > 0) {
      console.error(`  ✗ Diagram ${i + 1}: SYNTAX ERRORS`);
      errors.forEach(err => console.error(`    ${err}`));
      console.error(`    Diagram preview:`);
      console.error(diagram.split('\n').slice(0, 5).map(l => `      ${l}`).join('\n'));
      hasErrors = true;
    } else {
      console.log(`  ✓ Diagram ${i + 1}: Syntax looks valid`);
    }
  }
}

if (hasErrors) {
  console.error('\n❌ Validation found syntax errors');
  process.exit(1);
} else {
  console.log('\n✅ All Mermaid diagrams pass syntax validation');
}
