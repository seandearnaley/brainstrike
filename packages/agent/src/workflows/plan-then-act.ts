import type {
  AgentMessage,
  AgentMessagePartText,
  RuntimeData,
  StreamChunk,
  StreamIterator,
} from '../index';
import { validateToolInput } from '../tools/schemas';

function extractLastUserText(messages: AgentMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = last?.parts.find((p) => p.type === 'text') as AgentMessagePartText | undefined;
  return text?.text ?? '';
}

function shouldSearch(userText: string): boolean {
  const lowered = userText.toLowerCase();
  return /search|find|look up|docs?|documentation|help/.test(lowered);
}

function parseListFiles(userText: string): { match: boolean; path?: string } {
  const m = /\blist\s+files(?:\s+in|\s+at)?\s+([^\n]+)$/i.exec(userText);
  if (m) {
    const p = m[1]?.trim();
    return p ? { match: true, path: p } : { match: true };
  }
  // Also handle bare "list files"
  if (/\blist\s+files\b/i.test(userText)) return { match: true };
  return { match: false };
}

function parseEcho(userText: string): { match: boolean; text?: string } {
  const m = /^\s*echo\s+(.+)$/i.exec(userText.trim());
  if (m) {
    const t = m[1]?.trim();
    return t ? { match: true, text: t } : { match: true };
  }
  // support 'ping web' as a simple trigger
  if (/\bping\s+web\b/i.test(userText)) return { match: true, text: 'ping' };
  return { match: false };
}

async function* streamTokens(text: string, delayMs = 3): AsyncIterableIterator<StreamChunk> {
  for (const token of text.split(/(\s+)/)) {
    if (token) yield { type: 'text-delta', value: token } satisfies StreamChunk;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

async function* handlePlanStep(
  userText: string,
  runtime?: RuntimeData
): AsyncIterableIterator<StreamChunk> {
  yield {
    type: 'tool-event',
    name: 'plan',
    status: 'start',
    payload: { runtime },
  } satisfies StreamChunk;

  const plan = shouldSearch(userText)
    ? 'Plan: 1) search for relevant info 2) synthesize 3) answer'
    : 'Plan: 1) reason step-by-step 2) answer';

  yield* streamTokens(plan);
  yield { type: 'tool-event', name: 'plan', status: 'success' } satisfies StreamChunk;
}

async function* handleSearchStep(userText: string): AsyncIterableIterator<StreamChunk> {
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

async function* handleFileListStep(
  listReq: { match: boolean; path?: string },
  runtime?: RuntimeData
): AsyncIterableIterator<StreamChunk> {
  yield {
    type: 'tool-event',
    name: 'filesystem.list',
    status: 'start',
    payload: { path: listReq.path },
  } satisfies StreamChunk;

  try {
    const validation = validateToolInput('filesystem.list', { path: listReq.path });
    if (!validation.ok) {
      throw new Error(
        `invalid_input: ${(validation as { ok: false; issues: string[] }).issues.join('; ')}`
      );
    }
    if (!runtime?.callTool) throw new Error('callTool not available');
    const result = await runtime.callTool(
      'filesystem.list',
      validation.data as Record<string, unknown>
    );
    yield {
      type: 'tool-event',
      name: 'filesystem.list',
      status: 'success',
      payload: result,
    } satisfies StreamChunk;
  } catch (err) {
    yield {
      type: 'tool-event',
      name: 'filesystem.list',
      status: 'error',
      payload: { error: err instanceof Error ? err.message : String(err) },
    } satisfies StreamChunk;
  }
}

async function* handleWebEchoStep(
  echoReq: { match: boolean; text?: string },
  runtime?: RuntimeData
): AsyncIterableIterator<StreamChunk> {
  yield {
    type: 'tool-event',
    name: 'web.echo',
    status: 'start',
    payload: { text: echoReq.text },
  } satisfies StreamChunk;
  try {
    const validation = validateToolInput('web.echo', { text: echoReq.text });
    if (!validation.ok) {
      throw new Error(
        `invalid_input: ${(validation as { ok: false; issues: string[] }).issues.join('; ')}`
      );
    }
    if (!runtime?.callTool) throw new Error('callTool not available');
    const result = await runtime.callTool('web.echo', validation.data as Record<string, unknown>);
    yield {
      type: 'tool-event',
      name: 'web.echo',
      status: 'success',
      payload: result,
    } satisfies StreamChunk;
  } catch (err) {
    yield {
      type: 'tool-event',
      name: 'web.echo',
      status: 'error',
      payload: { error: err instanceof Error ? err.message : String(err) },
    } satisfies StreamChunk;
  }
}

async function* handleSynthesizeStep(
  userText: string,
  listReq: { match: boolean; path?: string },
  runtime?: RuntimeData
): AsyncIterableIterator<StreamChunk> {
  yield { type: 'tool-event', name: 'synthesize', status: 'start' } satisfies StreamChunk;

  const didSearch = shouldSearch(userText);
  const didList = listReq.match && !!(runtime?.mcpEnabled && runtime?.callTool);
  const answer = didSearch
    ? 'Here is a synthesized answer based on the (simulated) search.'
    : didList
      ? 'Listed files as requested.'
      : 'Here is a step-by-step reasoning response.';

  yield* streamTokens(`\n${answer}`);
  yield { type: 'tool-event', name: 'synthesize', status: 'success' } satisfies StreamChunk;
}

export async function* streamPlanThenAct(
  messages: AgentMessage[],
  runtime?: RuntimeData
): StreamIterator {
  const userText = extractLastUserText(messages);

  // Step 1: Plan
  yield* handlePlanStep(userText, runtime);

  // Step 2: (Optional) Act (tools)
  if (shouldSearch(userText)) {
    yield* handleSearchStep(userText);
  }

  // Desktop MCP tool: filesystem.list
  const listReq = parseListFiles(userText);
  if (listReq.match && runtime?.mcpEnabled && typeof runtime.callTool === 'function') {
    yield* handleFileListStep(listReq, runtime);
  }

  // Desktop MCP (SSE) demo: web.echo
  const echoReq = parseEcho(userText);
  if (echoReq.match && runtime?.mcpEnabled && typeof runtime.callTool === 'function') {
    yield* handleWebEchoStep(echoReq, runtime);
  }

  // Step 3: Synthesize
  yield* handleSynthesizeStep(userText, listReq, runtime);
}
