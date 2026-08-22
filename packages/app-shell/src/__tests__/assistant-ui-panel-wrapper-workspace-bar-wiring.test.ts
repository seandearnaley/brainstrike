import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8');
}

/**
 * The tripwire the type system cannot provide on its own: the bar's props are
 * structurally close enough that swapping the composed `workspaceBar` object
 * back for the older per-field `operatingRoot*` wiring would still type-check
 * while silently rendering a different bar. Pinning the one line that carries
 * the whole object makes that swap a test failure.
 */
describe('assistant panel wrapper workspace-bar wiring', () => {
  it('passes the composed workspaceBar object, never loose operatingRoot props', () => {
    const source = readSource('assistant-ui-panel-wrapper.tsx');

    expect(source).toContain('workspaceBar={workspaceBar}');
    expect(source).toContain('useWorkspaceBar({');
    expect(source).not.toMatch(/\boperatingRoot=\{/u);
    expect(source).not.toMatch(/\{\.\.\.operatingRoot\b/u);
  });
});
