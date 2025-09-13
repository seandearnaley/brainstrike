import { describe, expect, it } from 'vitest';
import { type AgentMessage, streamEcho } from '../index';

async function collectEchoChunks(messages: AgentMessage[]) {
  const textParts: string[] = [];
  let start = false;
  let success = false;
  for await (const c of streamEcho(messages)) {
    if (c.type === 'tool-event') {
      if (c.status === 'start') start = true;
      if (c.status === 'success') success = true;
      continue;
    }
    if (c.type === 'text-delta') textParts.push(c.value);
  }
  return { start, success, text: textParts.join('') };
}

describe('agent echo stream', () => {
  it('streams back user text tokens and tool events', async () => {
    const messages: AgentMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello world' }] },
    ];
    const result = await collectEchoChunks(messages);
    expect(result.start).toBe(true);
    expect(result.success).toBe(true);
    expect(result.text).toContain('hello');
  });
});
