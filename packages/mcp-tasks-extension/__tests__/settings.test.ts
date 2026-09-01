import { describe, expect, it } from 'vitest';
import {
  MCP_TASKS_EXTENSION_ID,
  MCP_TASKS_EXTENSION_SETTINGS,
  MCP_TASKS_EXTENSION_VERSION,
  parseMcpTasksExtensionSettings,
} from '../src/index.js';

describe('MCP Tasks extension settings', () => {
  it('accepts exactly the empty 2026-07-28 capability settings', () => {
    expect(MCP_TASKS_EXTENSION_ID).toBe('io.modelcontextprotocol/tasks');
    expect(MCP_TASKS_EXTENSION_VERSION).toBe('2026-07-28');
    expect(MCP_TASKS_EXTENSION_SETTINGS).toEqual({});
    expect(parseMcpTasksExtensionSettings({})).toEqual({});
  });

  it.each([null, [], 'enabled', { enabled: true }, { version: '2026-07-28' }])(
    'rejects malformed or non-empty settings %#',
    (settings) => {
      expect(() => parseMcpTasksExtensionSettings(settings)).toThrow();
    }
  );
});
