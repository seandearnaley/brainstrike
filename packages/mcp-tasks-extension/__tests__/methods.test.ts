import { describe, expect, it } from 'vitest';
import {
  MCP_TASKS_NOTIFICATION_METHODS,
  MCP_TASKS_REQUEST_METHODS,
  parseMcpTasksMethod,
} from '../src/index.js';

describe('MCP Tasks extension method vocabulary', () => {
  it('pins only the official 2026-07-28 methods', () => {
    expect(MCP_TASKS_REQUEST_METHODS).toEqual(['tasks/get', 'tasks/update', 'tasks/cancel']);
    expect(MCP_TASKS_NOTIFICATION_METHODS).toEqual(['notifications/tasks']);
    for (const method of [...MCP_TASKS_REQUEST_METHODS, ...MCP_TASKS_NOTIFICATION_METHODS]) {
      expect(parseMcpTasksMethod(method)).toBe(method);
    }
  });

  it.each([
    'tasks/list',
    'tasks/result',
    'notifications/tasks/status',
    'tools/call',
    'tasks/get/extra',
    '',
    null,
  ])('rejects non-extension or retired method vocabulary %#', (method) => {
    expect(() => parseMcpTasksMethod(method)).toThrow();
  });
});
