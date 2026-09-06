import { describe, expect, it } from 'vitest';
import {
  parseMcpTaskSubscriptionAcknowledgedNotifications,
  parseMcpTaskSubscriptionNotifications,
  type TaskSubscriptionAcknowledgedNotifications,
  type TaskSubscriptionNotifications,
} from '../src/index.js';

describe('MCP Tasks subscription additions', () => {
  it('parses optional task ID lists for listen and acknowledged notifications', () => {
    const listen: TaskSubscriptionNotifications = { taskIds: ['task-1', 'task-2'] };
    const acknowledged: TaskSubscriptionAcknowledgedNotifications = { taskIds: [] };

    expect(parseMcpTaskSubscriptionNotifications({})).toEqual({});
    expect(parseMcpTaskSubscriptionNotifications(listen)).toEqual(listen);
    expect(parseMcpTaskSubscriptionAcknowledgedNotifications(acknowledged)).toEqual(acknowledged);
  });

  it.each([
    { taskIds: 'task-1' },
    { taskIds: [1] },
    { taskIds: ['task-1', null] },
    { taskIds: null },
  ])('rejects malformed task ID lists %#', (notifications) => {
    expect(() => parseMcpTaskSubscriptionNotifications(notifications)).toThrow();
    expect(() => parseMcpTaskSubscriptionAcknowledgedNotifications(notifications)).toThrow();
  });
});
