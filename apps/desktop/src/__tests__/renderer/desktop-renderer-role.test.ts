import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopRendererRole } from '../../renderer/desktop-renderer-role';

const taskHarnessSource = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/components/mcp-task-status-e2e-harness.tsx'),
  'utf8'
);

describe('resolveDesktopRendererRole', () => {
  it('refuses the MCP Tasks verifier outside Desktop test mode', () => {
    expect(resolveDesktopRendererRole('?mode=mcp-task-harness', false)).toBe('visible-ui');
  });

  it('admits the MCP Tasks verifier only in Desktop test mode', () => {
    expect(resolveDesktopRendererRole('?mode=mcp-task-harness', true)).toBe('mcp-task-harness');
  });

  it('builds the packaged verifier through public browser-safe package exports', () => {
    expect(taskHarnessSource).toContain("from '@brainstrike/agent/mcp-tasks'");
    expect(taskHarnessSource).toContain("from '@brainstrike/assistant-ui/mcp-task-status-card'");
    expect(taskHarnessSource).not.toMatch(/packages\/[^/]+\/src\//u);
  });

  it.each([
    ['embedding-host', 'embedding-host'],
    ['chunking-host', 'chunking-host'],
    ['unknown', 'visible-ui'],
  ] as const)('preserves %s role resolution', (mode, expected) => {
    expect(resolveDesktopRendererRole(`?mode=${mode}`, false)).toBe(expected);
  });
});
