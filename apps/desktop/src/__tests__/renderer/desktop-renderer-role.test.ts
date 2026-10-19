import { describe, expect, it } from 'vitest';
import { resolveDesktopRendererRole } from '../../renderer/desktop-renderer-role';

describe('resolveDesktopRendererRole', () => {
  it.each([
    ['embedding-host', 'embedding-host'],
    ['chunking-host', 'chunking-host'],
    // The retired renderer MCP Tasks harness (BST-2130) is the visible UI now.
    ['mcp-task-harness', 'visible-ui'],
    ['unknown', 'visible-ui'],
  ] as const)('resolves ?mode=%s to the %s role', (mode, expected) => {
    expect(resolveDesktopRendererRole(`?mode=${mode}`)).toBe(expected);
  });

  it('resolves no mode to the visible UI', () => {
    expect(resolveDesktopRendererRole('')).toBe('visible-ui');
  });
});
