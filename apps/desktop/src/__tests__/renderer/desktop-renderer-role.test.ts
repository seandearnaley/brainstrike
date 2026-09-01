import { describe, expect, it } from 'vitest';
import { resolveDesktopRendererRole } from '../../renderer/desktop-renderer-role';

describe('resolveDesktopRendererRole', () => {
  it('refuses the MCP Tasks verifier outside Desktop test mode', () => {
    expect(resolveDesktopRendererRole('?mode=mcp-task-harness', false)).toBe('visible-ui');
  });

  it('admits the MCP Tasks verifier only in Desktop test mode', () => {
    expect(resolveDesktopRendererRole('?mode=mcp-task-harness', true)).toBe('mcp-task-harness');
  });

  it.each([
    ['embedding-host', 'embedding-host'],
    ['chunking-host', 'chunking-host'],
    ['llm-host', 'llm-host'],
    ['unknown', 'visible-ui'],
  ] as const)('preserves %s role resolution', (mode, expected) => {
    expect(resolveDesktopRendererRole(`?mode=${mode}`, false)).toBe(expected);
  });
});
