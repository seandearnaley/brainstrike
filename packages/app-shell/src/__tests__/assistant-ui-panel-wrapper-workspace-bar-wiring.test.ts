// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8');
}

/**
 * The tripwire the type system cannot provide on its own: the panel's
 * `workspaceBar` prop is a ReactNode, so ANY element type-checks there —
 * including one whose props were composed by calling `useWorkspaceBar` back in
 * the wrapper. That would silently reinstate the re-render this split removed
 * (the bar's two live-refresh subscriptions dragging the whole ~1850-line
 * wrapper along on every git push). Pinning the composition site makes that
 * regression a test failure.
 */
describe('assistant panel wrapper workspace-bar wiring', () => {
  it('renders the memoized bar HOST and never calls useWorkspaceBar itself', () => {
    const source = readSource('assistant-ui-panel-wrapper.tsx');

    expect(source).toContain('<WorkspaceBarHost');
    expect(source).toContain("from './workspace-bar/workspace-bar-host'");
    // The subscriptions must not live in this component, in any form.
    expect(source).not.toContain('useWorkspaceBar(');
    expect(source).not.toContain("from './hooks/use-workspace-bar'");
    // Nor may the loose per-field wiring the composed bar replaced come back.
    expect(source).not.toMatch(/\boperatingRoot=\{/u);
    expect(source).not.toMatch(/\{\.\.\.operatingRoot\b/u);
  });

  // The memo above only bails out while every prop is referentially stable, so
  // an inline object/array/arrow literal in the element below silently defeats
  // it — a fresh identity every wrapper render, with no type error and no
  // visible symptom beyond the re-render this split exists to remove.
  it('passes the host only referentially stable props', () => {
    const source = readSource('assistant-ui-panel-wrapper.tsx');
    const element = /<WorkspaceBarHost\b[\s\S]*?\/>/u.exec(source)?.[0];

    expect(element).toBeDefined();
    for (const literal of ['={{', '={[', '={(']) {
      expect(element).not.toContain(literal);
    }
  });

  it('keeps the host memoized so ordinary wrapper renders never reach the bar', () => {
    const hostSource = readSource('workspace-bar/workspace-bar-host.tsx');

    expect(hostSource).toContain('memo(function WorkspaceBarHost');
    expect(hostSource).toContain('useWorkspaceBar(args)');
    expect(hostSource).toContain('<WorkspaceBar {...barProps} />');
  });
});
