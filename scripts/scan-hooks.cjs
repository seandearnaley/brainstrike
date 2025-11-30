#!/usr/bin/env node
'use strict';
/**
 * Best-effort static scanner for risky React hook patterns.
 * Flags:
 *  - Hooks inside conditionals/loops (if/for/while/switch)
 *  - Hooks inside array callbacks (map/filter/reduce/forEach)
 *  - Inline ternary returning different hook shapes
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET_DIRS = ['packages/file-explorer-hooks/src', 'packages/file-explorer-ui/src'];

const EXTENSIONS = new Set(['.ts', '.tsx']);

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) {
      continue;
    }
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile() && EXTENSIONS.has(path.extname(e.name))) {
        out.push(p);
      }
    }
  }
  return out;
}

/** @param {string} code */
function scan(code) {
  const warnings = [];
  const normalized = code.replace(/\r\n?/g, '\n');

  // Hooks inside array callbacks
  const arrayCbPattern =
    /(map|filter|reduce|forEach)\s*\(([^)]*)\)\s*\{[\s\S]*?use[A-Z][A-Za-z]*\(/g;
  if (arrayCbPattern.test(normalized)) {
    warnings.push('Hook call inside array callback (map/filter/reduce/forEach)');
  }

  // Hooks inside if/for/while/switch blocks
  const controlBlockPattern = /(if|for|while|switch)\s*\([^)]*\)\s*\{[\s\S]*?use[A-Z][A-Za-z]*\(/g;
  if (controlBlockPattern.test(normalized)) {
    warnings.push('Hook call inside control-flow block (if/for/while/switch)');
  }

  // Ternary that contains hooks on either side
  const ternaryHookPattern = /\?[^:]*use[A-Z][A-Za-z]*\([^)]*\)[^:]*:[^\n]*use[A-Z][A-Za-z]*\(/g;
  if (ternaryHookPattern.test(normalized)) {
    warnings.push('Ternary expression with hook calls on branches');
  }

  return warnings;
}

/** main */
let hadIssues = false;
for (const rel of TARGET_DIRS) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) {
    continue;
  }
  for (const file of walk(dir)) {
    const code = fs.readFileSync(file, 'utf8');
    const issues = scan(code);
    if (issues.length) {
      hadIssues = true;
      console.log(`\n[hooks-scan] ${path.relative(ROOT, file)}`);
      for (const i of issues) {
        console.log(`  - ${i}`);
      }
    }
  }
}

if (hadIssues) {
  console.error(
    '\n[hooks-scan] Potential risky hook patterns found. Please refactor before enabling full compiler.'
  );
  process.exit(1);
} else {
  console.log('[hooks-scan] No risky hook patterns detected in scanned directories.');
}
