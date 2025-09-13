import type {
  AgentMessage,
  AgentMessagePartText,
  RuntimeData,
  StreamChunk,
  StreamIterator,
} from '../index';

function extractLastUserText(messages: AgentMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = last?.parts.find((p) => p.type === 'text') as AgentMessagePartText | undefined;
  return text?.text ?? '';
}

function shouldSearch(userText: string): boolean {
  const lowered = userText.toLowerCase();
  return /search|find|look up|docs?|documentation|help/.test(lowered);
}

export async function* streamPlanThenAct(
  messages: AgentMessage[],
  runtime?: RuntimeData
): StreamIterator {
  const userText = extractLastUserText(messages);

  // Step 1: Plan
  yield {
    type: 'tool-event',
    name: 'plan',
    status: 'start',
    payload: { runtime },
  } satisfies StreamChunk;
  const plan = shouldSearch(userText)
    ? 'Plan: 1) search for relevant info 2) synthesize 3) answer'
    : 'Plan: 1) reason step-by-step 2) answer';
  for (const token of plan.split(/(\s+)/)) {
    if (token) yield { type: 'text-delta', value: token } satisfies StreamChunk;
    await new Promise((r) => setTimeout(r, 3));
  }
  yield { type: 'tool-event', name: 'plan', status: 'success' } satisfies StreamChunk;

  // Step 2: (Optional) Act (simulate a tool)
  if (shouldSearch(userText)) {
    yield {
      type: 'tool-event',
      name: 'search',
      status: 'start',
      payload: { query: userText },
    } satisfies StreamChunk;
    await new Promise((r) => setTimeout(r, 10));
    yield {
      type: 'tool-event',
      name: 'search',
      status: 'success',
      payload: { hits: 3, note: 'simulated results' },
    } satisfies StreamChunk;
  }

  // Step 3: Synthesize
  yield { type: 'tool-event', name: 'synthesize', status: 'start' } satisfies StreamChunk;
  const answer = shouldSearch(userText)
    ? 'Here is a synthesized answer based on the (simulated) search.'
    : 'Here is a step-by-step reasoning response.';
  for (const token of ('\n' + answer).split(/(\s+)/)) {
    if (token) yield { type: 'text-delta', value: token } satisfies StreamChunk;
    await new Promise((r) => setTimeout(r, 3));
  }
  yield { type: 'tool-event', name: 'synthesize', status: 'success' } satisfies StreamChunk;
}
