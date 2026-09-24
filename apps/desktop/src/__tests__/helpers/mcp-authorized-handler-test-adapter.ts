import type { IpcMainInvokeEvent } from 'electron';
import {
  createAllowlistedSenderFrame,
  trackTestWindowRole,
} from './desktop-ipc-sender-test-helpers';

type RegisteredHandler = (...args: unknown[]) => unknown;

const DEFAULT_VISIBLE_SENDER_ID = 8_996_001;

function visibleEvent(senderId: number): IpcMainInvokeEvent {
  trackTestWindowRole(senderId, 'visible-ui');
  return {
    sender: { id: senderId },
    senderFrame: createAllowlistedSenderFrame('visible-ui'),
  } as unknown as IpcMainInvokeEvent;
}

/**
 * Adapts legacy behavior tests that called pre-authorization MCP handlers
 * with an empty/dummy Electron event. Authorization itself is covered by the
 * dedicated sender matrix; these tests remain focused on handler behavior.
 */
export function adaptMcpHandlerForVisibleUi<T extends RegisteredHandler>(handler: T): T {
  return ((...args: unknown[]) => {
    const first = args[0];
    if (args.length >= 2 && typeof first === 'object' && first !== null) {
      const senderId =
        'sender' in first &&
        typeof first.sender === 'object' &&
        first.sender !== null &&
        'id' in first.sender &&
        typeof first.sender.id === 'number'
          ? first.sender.id
          : DEFAULT_VISIBLE_SENDER_ID;
      return handler(visibleEvent(senderId), ...args.slice(1));
    }
    if (
      typeof first === 'object' &&
      first !== null &&
      'sender' in first &&
      typeof first.sender === 'object' &&
      first.sender !== null &&
      'id' in first.sender &&
      typeof first.sender.id === 'number'
    ) {
      return handler(visibleEvent(first.sender.id), ...args.slice(1));
    }
    return handler(visibleEvent(DEFAULT_VISIBLE_SENDER_ID), ...args);
  }) as T;
}
