/**
 * Successful streaming provider responses for offline HTTP tests. The frames
 * are the recorded in-repo shapes: OpenAI Responses from
 * packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts
 * (`responsesApiStream`), Anthropic Messages from
 * packages/agent/src/__tests__/anthropic-prompt-caching-wire.integration.spec.ts.
 */

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

export function openAIResponsesText(model: string, text: string): Response {
  const itemId = 'msg_offline_1';
  const part = { annotations: [], text, type: 'output_text' };
  const item = {
    content: [part],
    id: itemId,
    role: 'assistant',
    status: 'completed',
    type: 'message',
  };
  const response = {
    created_at: 1_753_600_000,
    id: 'resp_offline_1',
    model,
    object: 'response',
    output: [item],
    status: 'completed',
    usage: { input_tokens: 42, output_tokens: 9, total_tokens: 51 },
  };
  const position = { content_index: 0, item_id: itemId, output_index: 0 };
  const frames = [
    { response: { ...response, output: [], status: 'in_progress' }, type: 'response.created' },
    {
      item: { ...item, content: [], status: 'in_progress' },
      output_index: 0,
      type: 'response.output_item.added',
    },
    { ...position, part: { ...part, text: '' }, type: 'response.content_part.added' },
    { ...position, delta: text, type: 'response.output_text.delta' },
    { ...position, text, type: 'response.output_text.done' },
    { ...position, part, type: 'response.content_part.done' },
    { item, output_index: 0, type: 'response.output_item.done' },
    { response, type: 'response.completed' },
  ];
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    headers: SSE_HEADERS,
    status: 200,
  });
}

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function anthropicMessagesText(model: string, text: string): Response {
  const events =
    sseEvent('message_start', {
      message: {
        content: [],
        id: 'msg_offline_1',
        model,
        role: 'assistant',
        stop_reason: null,
        stop_sequence: null,
        type: 'message',
        usage: { input_tokens: 7, output_tokens: 0 },
      },
      type: 'message_start',
    }) +
    sseEvent('content_block_start', {
      content_block: { text: '', type: 'text' },
      index: 0,
      type: 'content_block_start',
    }) +
    sseEvent('content_block_delta', {
      delta: { text, type: 'text_delta' },
      index: 0,
      type: 'content_block_delta',
    }) +
    sseEvent('content_block_stop', { index: 0, type: 'content_block_stop' }) +
    sseEvent('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      type: 'message_delta',
      usage: { output_tokens: 3 },
    }) +
    sseEvent('message_stop', { type: 'message_stop' });
  return new Response(events, { headers: SSE_HEADERS, status: 200 });
}
