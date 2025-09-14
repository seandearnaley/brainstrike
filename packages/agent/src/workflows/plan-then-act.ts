import type {
  AgentMessage,
  AgentMessagePartText,
  RuntimeData,
  StreamChunk,
  StreamIterator,
} from '../index';
import { normalizeProgressPayload } from '../tools/progress-adapter';
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

function parseReadFile(userText: string): { match: boolean; path?: string } {
  // Support: "read file <path>", "read <path>", and bare "read file"
  const trimmed = userText.trim();
  const re = /(?:^|\b)read\s+(?:file\s+)?([^\n]+)?$/i;
  const m = re.exec(trimmed);
  if (m) {
    const p = (m[1] ?? '').trim();
    return p ? { match: true, path: p } : { match: true };
  }
  return { match: false };
}

function parseSearchFiles(userText: string): { match: boolean; query?: string; path?: string } {
  // Patterns: "search files <query>", "find files <query>", optional "in <path>"
  const re = /\b(?:search|find)\s+files?\s+([^\n]+?)(?:\s+in\s+([^\n]+))?$/i;
  const m = re.exec(userText);
  if (m) {
    const q = (m[1] ?? '').trim();
    const p = (m[2] ?? '').trim();
    if (!q) return { match: true };
    if (p) return { match: true, query: q, path: p };
    return { match: true, query: q };
  }
  return { match: false };
}

async function* streamTokens(text: string, delayMs = 3): AsyncIterableIterator<StreamChunk> {
  for (const token of text.split(/(\s+)/)) {
    if (token) yield { type: 'text-delta', value: token } satisfies StreamChunk;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

async function* handlePlanStep(
  _userText: string,
  _runtime?: RuntimeData
): AsyncIterableIterator<StreamChunk> {
  yield {
    type: 'tool-event',
    name: 'plan',
    status: 'start',
    // Do not include runtime in payload; it may contain functions (not cloneable across IPC)
  } satisfies StreamChunk;

  // Internal planning should not leak as assistant text. Keep as tool events only.
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
    const progressQueue: unknown[] = [];
    const pending = runtime.callTool(
      'filesystem.list',
      validation.data as Record<string, unknown>,
      {
        onProgress: (payload) => {
          progressQueue.push(normalizeProgressPayload(payload));
        },
      }
    );
    let done = false;
    while (!done) {
      const raced = await Promise.race([
        pending.then((v) => ({ done: true as const, value: v })),
        new Promise<{ done: false }>((res) => setTimeout(() => res({ done: false }), 30)),
      ]);
      while (progressQueue.length > 0) {
        const payload = progressQueue.shift();
        yield {
          type: 'tool-event',
          name: 'filesystem.list',
          status: 'progress',
          payload,
        } satisfies StreamChunk;
      }
      if ('done' in raced && raced.done) {
        const result = raced.value as unknown;
        yield {
          type: 'tool-event',
          name: 'filesystem.list',
          status: 'success',
          payload: result,
        } satisfies StreamChunk;
        done = true;
      }
    }
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
    const progressQueue: unknown[] = [];
    const pending = runtime.callTool('web.echo', validation.data as Record<string, unknown>, {
      onProgress: (payload) => progressQueue.push(normalizeProgressPayload(payload)),
    });
    let done = false;
    while (!done) {
      const raced = await Promise.race([
        pending.then((v) => ({ done: true as const, value: v })),
        new Promise<{ done: false }>((res) => setTimeout(() => res({ done: false }), 30)),
      ]);
      while (progressQueue.length > 0) {
        const payload = progressQueue.shift();
        yield {
          type: 'tool-event',
          name: 'web.echo',
          status: 'progress',
          payload,
        } satisfies StreamChunk;
      }
      if ('done' in raced && raced.done) {
        const result = raced.value as unknown;
        yield {
          type: 'tool-event',
          name: 'web.echo',
          status: 'success',
          payload: result,
        } satisfies StreamChunk;
        done = true;
      }
    }
  } catch (err) {
    yield {
      type: 'tool-event',
      name: 'web.echo',
      status: 'error',
      payload: { error: err instanceof Error ? err.message : String(err) },
    } satisfies StreamChunk;
  }
}

async function* handleFileReadStep(
  readReq: { match: boolean; path?: string },
  runtime?: RuntimeData
): AsyncIterableIterator<StreamChunk> {
  yield {
    type: 'tool-event',
    name: 'filesystem.read',
    status: 'start',
    payload: { path: readReq.path },
  } satisfies StreamChunk;
  try {
    const validation = validateToolInput('filesystem.read', { path: readReq.path });
    if (!validation.ok) {
      throw new Error(
        `invalid_input: ${(validation as { ok: false; issues: string[] }).issues.join('; ')}`
      );
    }
    if (!runtime?.callTool) throw new Error('callTool not available');
    const q: unknown[] = [];
    const pending = runtime.callTool(
      'filesystem.read',
      validation.data as Record<string, unknown>,
      {
        onProgress: (payload) => q.push(normalizeProgressPayload(payload)),
      }
    );
    let done = false;
    while (!done) {
      const raced = await Promise.race([
        pending.then((v) => ({ done: true as const, value: v })),
        new Promise<{ done: false }>((res) => setTimeout(() => res({ done: false }), 30)),
      ]);
      while (q.length > 0) {
        const payload = q.shift();
        yield {
          type: 'tool-event',
          name: 'filesystem.read',
          status: 'progress',
          payload,
        } satisfies StreamChunk;
      }
      if ('done' in raced && raced.done) {
        const result = raced.value as unknown;
        yield {
          type: 'tool-event',
          name: 'filesystem.read',
          status: 'success',
          payload: result,
        } satisfies StreamChunk;
        done = true;
      }
    }
  } catch (err) {
    yield {
      type: 'tool-event',
      name: 'filesystem.read',
      status: 'error',
      payload: { error: err instanceof Error ? err.message : String(err) },
    } satisfies StreamChunk;
  }
}

async function* handleFileSearchStep(
  searchReq: { match: boolean; query?: string; path?: string },
  runtime?: RuntimeData
): AsyncIterableIterator<StreamChunk> {
  yield {
    type: 'tool-event',
    name: 'filesystem.search',
    status: 'start',
    payload: { query: searchReq.query, path: searchReq.path },
  } satisfies StreamChunk;
  try {
    const validation = validateToolInput('filesystem.search', {
      query: searchReq.query,
      path: searchReq.path,
    });
    if (!validation.ok) {
      throw new Error(
        `invalid_input: ${(validation as { ok: false; issues: string[] }).issues.join('; ')}`
      );
    }
    if (!runtime?.callTool) throw new Error('callTool not available');
    const q: unknown[] = [];
    const pending = runtime.callTool(
      'filesystem.search',
      validation.data as Record<string, unknown>,
      {
        onProgress: (payload) => q.push(normalizeProgressPayload(payload)),
      }
    );
    let done = false;
    while (!done) {
      const raced = await Promise.race([
        pending.then((v) => ({ done: true as const, value: v })),
        new Promise<{ done: false }>((res) => setTimeout(() => res({ done: false }), 30)),
      ]);
      while (q.length > 0) {
        const payload = q.shift();
        yield {
          type: 'tool-event',
          name: 'filesystem.search',
          status: 'progress',
          payload,
        } satisfies StreamChunk;
      }
      if ('done' in raced && raced.done) {
        const result = raced.value as unknown;
        yield {
          type: 'tool-event',
          name: 'filesystem.search',
          status: 'success',
          payload: result,
        } satisfies StreamChunk;
        done = true;
      }
    }
  } catch (err) {
    yield {
      type: 'tool-event',
      name: 'filesystem.search',
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
  const isGreeting = /\b(hi|hello|hey)\b/i.test(userText);
  const answer = didSearch
    ? 'Here is a synthesized answer based on the (simulated) search.'
    : didList
      ? 'Listed files as requested.'
      : isGreeting
        ? 'Hello! How can I help?'
        : `You said: "${userText}"`;

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

  // Desktop MCP tool: filesystem.read
  const readReq = parseReadFile(userText);
  if (readReq.match && runtime?.mcpEnabled && typeof runtime.callTool === 'function') {
    yield* handleFileReadStep(readReq, runtime);
  }

  // Desktop MCP tool: filesystem.search
  const searchReq = parseSearchFiles(userText);
  if (searchReq.match && runtime?.mcpEnabled && typeof runtime.callTool === 'function') {
    yield* handleFileSearchStep(searchReq, runtime);
  }

  // Desktop MCP (SSE) demo: web.echo
  const echoReq = parseEcho(userText);
  if (echoReq.match && runtime?.mcpEnabled && typeof runtime.callTool === 'function') {
    yield* handleWebEchoStep(echoReq, runtime);
  }

  // Step 3: Synthesize
  yield* handleSynthesizeStep(userText, listReq, runtime);
}
