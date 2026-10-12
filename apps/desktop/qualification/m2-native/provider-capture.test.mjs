import assert from 'node:assert/strict';
import test from 'node:test';
import { startCapturingProvider } from './provider-capture.ts';

test('script switches preserve real provider output capture and keep title requests outside it', async () => {
  const capture = await startCapturingProvider({ finalText: 'initial' });
  const request = async (messages, tools = [{ function: { name: 'query' }, type: 'function' }]) => {
    const response = await fetch(`${capture.baseUrl}/chat/completions`, {
      body: JSON.stringify({ messages, stream: false, tools }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const old = { content: 'old EXPLAIN', role: 'tool', tool_call_id: 'old-call' };
    const history = [{ content: 'first', role: 'user' }, old];
    await request(history);
    assert.deepEqual(capture.outputs(), [old]);
    capture.setScript({
      finalText: 'recovery',
      toolCall: { arguments: { sql: 'SELECT 1941' }, name: 'query' },
    });
    const title = await request([{ content: 'title', role: 'user' }], []);
    assert.equal(title.choices[0].message.content, 'M2 native tool qualification');
    assert.deepEqual(capture.outputs(), [old]);
    const fresh = [...history, { content: 'fresh', role: 'user' }];
    const selected = await request(fresh);
    const call = selected.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'query');
    assert.notEqual(call.id, old.tool_call_id);
    assert.deepEqual(capture.outputs(), []);
    const actual = { content: 'm2_after_user_stop 1941', role: 'tool', tool_call_id: call.id };
    const final = await request([...fresh, actual]);
    assert.equal(final.choices[0].message.content, 'recovery');
    assert.deepEqual(capture.outputs(), [actual]);
    capture.setScript(() => ({ finalText: 'selector recovery' }));
    await request([...fresh, actual]);
    await request([{ content: 'later title', role: 'user' }], []);
    assert.deepEqual(capture.outputs(), [actual]);
  } finally {
    await capture.close();
  }
});
