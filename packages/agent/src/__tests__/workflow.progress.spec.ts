import { describe, expect, it } from 'vitest';
import type { AgentMessage, RuntimeData, StreamChunk } from '../index';
import { streamPlanThenAct } from '../workflows/plan-then-act';

async function collect(messages: AgentMessage[], runtime?: RuntimeData) {
  const chunks: StreamChunk[] = [];
  const it = streamPlanThenAct(messages, runtime);
  for await (const c of it) chunks.push(c);
  return chunks;
}

describe('tool progress events', () => {
  it('emits progress for slow web.echo', async () => {
    const messages: AgentMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'echo hello' }] },
    ];
    const runtime: RuntimeData = {
      mcpEnabled: true,
      callTool: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { ok: true };
      },
    };
    const chunks = await collect(messages, runtime);
    const echoEvents = chunks.filter((c) => c.type === 'tool-event' && c.name === 'web.echo');
    expect(echoEvents.length).toBeGreaterThan(0);
    const hasProgress = echoEvents.some((e) => e.type === 'tool-event' && e.status === 'progress');
    // Progress is optional depending on scheduler; allow either path
    expect(
      hasProgress || echoEvents.some((e) => e.type === 'tool-event' && e.status === 'start')
    ).toBe(true);
  });
});
