/**
 * Install-coupled guard for the D4 internal-approval exemption set.
 *
 * `MASTRA_INTERNAL_APPROVAL_EXEMPT_TOOLS` mirrors tool-name constants that are
 * INTERNAL to @mastra/memory (not exported publicly), so nothing type-checks
 * the mirror. If a bump renames `updateWorkingMemory`/`setWorkingMemory` (or
 * moves them), the run-wide `requireToolApproval: true` resume leg would raise
 * a spurious approval card for internal working-memory bookkeeping — the D4
 * defect — and the synthetic-stream D4 test would keep passing because it
 * restates the literal names. This test greps the INSTALLED dist for the
 * canonical `*_WORKING_MEMORY_TOOL_NAME` constants instead, so the mirror
 * breaks loudly at the next bump.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isApprovalExemptInternalTool } from '../internal-approval-exempt-tools';

function resolveMemoryDistDir(): string {
  const require = createRequire(import.meta.url);
  // The package hides package.json behind exports; resolve the entry module
  // and walk up to the package's dist directory instead.
  const entry = require.resolve('@mastra/memory');
  return path.dirname(entry);
}

function collectWorkingMemoryToolNames(distDir: string): Map<string, string> {
  const names = new Map<string, string>();
  const pattern = /(UPDATE|SET)_WORKING_MEMORY_TOOL_NAME\s*=\s*"([^"]+)"/g;
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) {
      continue;
    }
    const content = readFileSync(path.join(distDir, file), 'utf8');
    for (const match of content.matchAll(pattern)) {
      const kind = match[1];
      const name = match[2];
      if (kind && name) {
        names.set(kind, name);
      }
    }
  }
  return names;
}

describe('internal approval-exempt tools mirror the installed @mastra/memory', () => {
  it('finds both canonical working-memory tool-name constants in the installed dist', () => {
    const names = collectWorkingMemoryToolNames(resolveMemoryDistDir());
    // A vanished constant means the bookkeeping tool was renamed or relocated;
    // the exemption set (and this guard's pattern) must be re-verified.
    expect(names.get('UPDATE')).toBe('updateWorkingMemory');
    expect(names.get('SET')).toBe('setWorkingMemory');
  });

  it('exempts exactly the installed canonical names', () => {
    const names = collectWorkingMemoryToolNames(resolveMemoryDistDir());
    for (const name of names.values()) {
      expect(isApprovalExemptInternalTool(name)).toBe(true);
    }
  });
});
