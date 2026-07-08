import { describe, expect, it } from 'vitest';

import {
  completeToolCall,
  createToolRegistry,
  recordToolProgress,
  startToolCall,
  type ToolCallControllerLike,
  type ToolRegistry,
} from '../stream/tool-registry';

class ControllerMock implements ToolCallControllerLike {
  readonly args: string[] = [];
  response: { result: unknown; isError: boolean } | undefined;
  closed = false;

  argsText = {
    append: (text: string) => {
      this.args.push(text);
    },
  };

  setResponse(options: { result: unknown; isError: boolean }) {
    this.response = options;
  }

  close() {
    this.closed = true;
  }
}

function createRegistry(): ToolRegistry<ControllerMock> {
  return createToolRegistry<ControllerMock>();
}

describe('tool registry', () => {
  it('tracks tool calls with explicit call ids end-to-end', () => {
    const registry = createRegistry();
    const controller = new ControllerMock();

    startToolCall(registry, 'web.search', { callId: 'call-1', query: 'vite' }, controller);

    expect(controller.args[0]).toContain('"callId": "call-1"');
    expect(controller.args[0]).toContain('"query": "vite"');

    const progress = recordToolProgress(registry, 'web.search', {
      percent: 42.3,
      step: 'Downloading',
      toolCallId: 'call-1',
    });

    expect(progress).toBe('Downloading (42%)');
    expect(controller.args[1]).toContain('Downloading (42%)');

    completeToolCall(registry, 'web.search', 'error', {
      result: { items: ['a', 'b'] },
      toolCallId: 'call-1',
    });

    expect(controller.response).toEqual({
      isError: true,
      result: { result: { items: ['a', 'b'] }, toolCallId: 'call-1' },
    });
    expect(controller.closed).toBe(true);
  });

  it('routes progress updates to the latest controller when ids are absent', () => {
    const registry = createRegistry();
    const first = new ControllerMock();
    const second = new ControllerMock();

    startToolCall(registry, 'web.search', undefined, first);
    const progressLine = recordToolProgress(registry, 'web.search', { percent: 10 });
    expect(progressLine).toBe('Progress (10%)');
    expect(first.args[0]).toContain('Progress (10%)');

    startToolCall(registry, 'web.search', { callId: 'explicit-id' }, second);
    recordToolProgress(registry, 'web.search', { note: 'step', toolCallId: 'explicit-id' });
    expect(second.args[0]).toContain('"callId": "explicit-id"');
    expect(second.args[1]).toContain('Progress — step');
  });

  it('serializes complex payloads without mutating the originals on completion', () => {
    const registry = createRegistry();
    const controller = new ControllerMock();
    const payload = { callId: 'complex', data: new Map([['k', 'v']]) };

    startToolCall(registry, 'tool.io', payload, controller);

    completeToolCall(registry, 'tool.io', 'success', payload);

    expect(controller.response?.isError).toBe(false);
    expect(controller.response?.result).toEqual({
      callId: 'complex',
      data: { __type: 'Map', entries: { k: 'v' } },
    });
    // Ensure the original payload map was not mutated.
    expect(payload.data instanceof Map).toBe(true);
  });
});
