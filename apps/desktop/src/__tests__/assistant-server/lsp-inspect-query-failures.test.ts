/**
 * BST-1614: an `lspInspect` query that TIMED OUT or THREW must be
 * distinguishable from one that genuinely returned nothing.
 *
 * Before this contract, `queryHover`/`queryLocations` swallowed both a
 * `withTimeout` expiry and a thrown transport error into `undefined` / `[]`,
 * and `getLspInspection` simply omitted the empty group — so the model read
 * `{available:true, language:'typescript'}` as "the language server confirmed
 * this symbol has no definition / no implementations", a confidently wrong
 * claim about the user's own code with nothing pointing at the real cause.
 *
 * The wire is faked here on purpose: the real-subprocess lane
 * (lsp-diagnostics.integration.test.ts) cannot force a per-query timeout or a
 * transport throw deterministically. Everything ABOVE the JSON-RPC connection —
 * pool, diagnose lock, inspect(), the model-facing mapping — is the real code.
 */
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warnSpy, wire } = vi.hoisted(() => {
  const state = {
    notificationHandlers: new Map<string, (params: unknown) => void>(),
    /** Diagnostics published in response to didOpen (null = never publishes). */
    publish: null as { diagnostics: unknown[]; uri: string } | null,
    /** Delay before that publish lands, in ms of the fake clock (0 = sync). */
    publishDelayMs: 0,
    /** Per-method responder; a never-settling promise models a timeout. */
    respond: (_method: string): Promise<unknown> => Promise.resolve(null),
  };
  return { warnSpy: vi.fn(), wire: state };
});

// This suite isolates per-leg query failures. Real project policy and document
// lifetime are covered by lsp-policy-freshness and lsp-document-session tests.
vi.mock('../../assistant-server/lsp-document-session', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../assistant-server/lsp-document-session')>();
  return {
    ...actual,
    withLspDocument: async <T>(
      session: Parameters<typeof actual.withLspDocument>[0],
      task: (uri: string) => Promise<T>
    ): Promise<T> => {
      const uri = pathToFileURL(session.absolutePath).href;
      await session.connection.sendNotification('textDocument/didOpen', {});
      return task(uri);
    },
  };
});

vi.mock('electron', () => ({}));
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: warnSpy }),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  interface FakeChild extends EventEmitter {
    exitCode: number | null;
    kill: (signal?: NodeJS.Signals) => boolean;
    pid: number;
    signalCode: NodeJS.Signals | null;
    stderr: EventEmitter;
    stdin: EventEmitter;
    stdout: EventEmitter;
  }
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as FakeChild;
      child.pid = 4242;
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        child.exitCode = 0;
        queueMicrotask(() => child.emit('exit', 0, null));
        return true;
      };
      return child;
    },
  };
});

vi.mock('vscode-jsonrpc/node', () => ({
  createMessageConnection: () => ({
    dispose: () => undefined,
    listen: () => undefined,
    onError: () => ({ dispose: () => undefined }),
    onNotification: (method: string, handler: (params: unknown) => void) => {
      wire.notificationHandlers.set(method, handler);
      return { dispose: () => undefined };
    },
    sendNotification: (method: string) => {
      if (
        (method === 'textDocument/didOpen' || method === 'textDocument/didChange') &&
        wire.publish
      ) {
        const deliver = () => {
          if (wire.publish) {
            wire.notificationHandlers.get('textDocument/publishDiagnostics')?.(wire.publish);
          }
        };
        if (wire.publishDelayMs > 0) {
          setTimeout(deliver, wire.publishDelayMs);
        } else {
          deliver();
        }
      }
      return Promise.resolve();
    },
    sendRequest: (method: string) => wire.respond(method),
  }),
  StreamMessageReader: class {},
  StreamMessageWriter: class {},
}));

import { disposeLspServers, getLspInspection } from '../../assistant-server/lsp-diagnostics';

const ROOT = path.join(os.tmpdir(), 'brainstrike-lsp-inspect-failures');
const FILE = path.join(ROOT, 'target.ts');
const FILE_URI = new URL(`file://${FILE}`).href;
const CONTENT = 'export const computeTotal = (a: number): number => a;\n';

const resolveServerForTest = () => ({
  args: [],
  cliPath: '/fake/language-server.mjs',
  initializationOptions: {},
});

/** A definition/implementation Location the server "found". */
const LOCATION = {
  range: { start: { character: 13, line: 0 } },
  uri: FILE_URI,
};

/** Build a responder from a per-method behaviour map. */
function responder(behaviour: Record<string, 'hang' | 'throw' | unknown>) {
  return (method: string): Promise<unknown> => {
    const entry = behaviour[method];
    if (entry === 'hang') {
      // Never settles — `withTimeout` must win the race.
      return new Promise(() => undefined);
    }
    if (entry === 'throw') {
      return Promise.reject(new Error('connection closed mid-request'));
    }
    if (entry instanceof Error) {
      return Promise.reject(entry);
    }
    return Promise.resolve(entry ?? null);
  };
}

/**
 * Run an inspection under fake timers, driving the clock far enough past
 * QUERY_TIMEOUT_MS (4s) and DIAGNOSTIC_TIMEOUT_MS (6s) that every bounded wait
 * inside the call settles without any real wall-clock delay.
 */
async function inspect() {
  const pending = getLspInspection({
    absolutePath: FILE,
    content: CONTENT,
    position: { character: 13, line: 0 },
    resolveServerForTest,
    rootId: 'root-failures',
    rootPath: ROOT,
  });
  await vi.advanceTimersByTimeAsync(20_000);
  return pending;
}

describe('lspInspect per-query failures are distinguishable from empty results', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy.mockClear();
    wire.notificationHandlers.clear();
    wire.publishDelayMs = 0;
    // A real (non-empty) publish so the diagnostics leg settles immediately and
    // only the query under test is slow/broken.
    wire.publish = {
      diagnostics: [
        {
          message: 'unused variable',
          range: { start: { character: 13, line: 0 } },
          severity: 2,
          source: 'ts',
        },
      ],
      uri: FILE_URI,
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disposeLspServers();
  });

  it('reports a genuinely empty definition/implementation as answered, with no failures', async () => {
    wire.respond = responder({
      initialize: { capabilities: {} },
      'textDocument/definition': [],
      'textDocument/hover': null,
      'textDocument/implementation': [],
    });

    const result = await inspect();

    expect(result.available).toBe(true);
    expect(result.definition).toBeUndefined();
    expect(result.implementation).toBeUndefined();
    // The control: nothing failed, so the absent groups ARE verified-empty.
    expect(result.queryFailures).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('marks a TIMED-OUT definition query as unanswered rather than empty', async () => {
    wire.respond = responder({
      initialize: { capabilities: {} },
      'textDocument/definition': 'hang',
      'textDocument/hover': null,
      'textDocument/implementation': [],
    });

    const result = await inspect();

    expect(result.available).toBe(true);
    expect(result.definition).toBeUndefined();
    expect(result.queryFailures).toEqual([
      expect.objectContaining({ query: 'definition', reason: 'timeout' }),
    ]);
    expect(result.queryFailures?.[0]?.message).toMatch(/timed out/i);
    // Visible to a human at the DEFAULT log level — not `debug`.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('marks a THROWN implementation query as unanswered rather than empty', async () => {
    wire.respond = responder({
      initialize: { capabilities: {} },
      'textDocument/definition': [LOCATION],
      'textDocument/hover': null,
      'textDocument/implementation': 'throw',
    });

    const result = await inspect();

    expect(result.available).toBe(true);
    expect(result.implementation).toBeUndefined();
    expect(result.queryFailures).toEqual([
      expect.objectContaining({ query: 'implementation', reason: 'error' }),
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps a succeeding hover while reporting the sibling queries that failed', async () => {
    wire.respond = responder({
      initialize: { capabilities: {} },
      'textDocument/definition': 'hang',
      'textDocument/hover': { contents: { kind: 'markdown', value: 'const computeTotal: number' } },
      'textDocument/implementation': 'throw',
    });

    const result = await inspect();

    // A partial failure must NOT collapse the whole inspection.
    expect(result.available).toBe(true);
    expect(result.hover).toBe('const computeTotal: number');
    expect(result.diagnostics?.length ?? 0).toBeGreaterThan(0);
    expect(result.definition).toBeUndefined();
    expect(result.implementation).toBeUndefined();
    expect(result.queryFailures?.map((failure) => `${failure.query}:${failure.reason}`)).toEqual([
      'definition:timeout',
      'implementation:error',
    ]);
  });

  it('marks the diagnostics leg unanswered when an empty publish lands too late to settle', async () => {
    // DIAGNOSTIC_TIMEOUT_MS is 6s and DIAGNOSTIC_SETTLE_MS is 700ms. An empty
    // publish at 5.9s puts an entry in the map but leaves no room for the
    // settle window, so "clean" was never established. Inferring the answer
    // from map PRESENCE afterwards reports it as a verified-clean line.
    wire.publish = { diagnostics: [], uri: FILE_URI };
    wire.publishDelayMs = 5900;
    wire.respond = responder({
      initialize: { capabilities: {} },
      'textDocument/definition': [LOCATION],
      'textDocument/hover': null,
      'textDocument/implementation': [],
    });

    const result = await inspect();

    expect(result.available).toBe(true);
    expect(result.diagnostics).toBeUndefined();
    expect(result.queryFailures).toEqual([
      expect.objectContaining({ query: 'diagnostics', reason: 'timeout' }),
    ]);
  });

  it('does not let a publish arriving DURING the semantic queries fake a settled result', async () => {
    // The line diagnostics were already captured (empty) before the queries
    // ran. A publish landing while hover/definition/implementation are still
    // in flight must not retroactively mark the leg answered.
    wire.publish = {
      diagnostics: [
        {
          message: 'late arrival',
          range: { start: { character: 13, line: 0 } },
          severity: 1,
          source: 'ts',
        },
      ],
      uri: FILE_URI,
    };
    wire.publishDelayMs = 7000;
    wire.respond = responder({
      initialize: { capabilities: {} },
      'textDocument/definition': 'hang',
      'textDocument/hover': null,
      'textDocument/implementation': [],
    });

    const result = await inspect();

    expect(result.available).toBe(true);
    expect(result.diagnostics).toBeUndefined();
    expect(result.queryFailures?.map((failure) => `${failure.query}:${failure.reason}`)).toEqual([
      'diagnostics:timeout',
      'definition:timeout',
    ]);
  });

  it('marks a TIMED-OUT hover as unanswered while siblings still answer', async () => {
    // Hover is the leg where the collapse is least mechanical: a successful
    // query legitimately yields `value: undefined`, so "answered, no hover"
    // and "never answered" both end with no `hover` key.
    wire.respond = responder({
      initialize: { capabilities: {} },
      'textDocument/definition': [LOCATION],
      'textDocument/hover': 'hang',
      'textDocument/implementation': [],
    });

    const result = await inspect();

    expect(result.available).toBe(true);
    expect(result.hover).toBeUndefined();
    expect(result.definition?.length).toBe(1);
    expect(result.queryFailures).toEqual([
      expect.objectContaining({ query: 'hover', reason: 'timeout' }),
    ]);
  });

  it('records NO failure when hover answers with no hover text', async () => {
    // The hover analogue of the honest-empty control: same absent `hover` key,
    // opposite meaning, and the two must stay distinguishable.
    wire.respond = responder({
      initialize: { capabilities: {} },
      'textDocument/definition': [LOCATION],
      'textDocument/hover': { contents: '   ' },
      'textDocument/implementation': [],
    });

    const result = await inspect();

    expect(result.available).toBe(true);
    expect(result.hover).toBeUndefined();
    expect(result.queryFailures).toBeUndefined();
  });

  it('bounds and single-lines a huge transport-error detail in the RETURNED record', async () => {
    // queryFailures is a returned value, not only a projected one: the model
    // projection clips what it renders, but any other consumer gets this
    // string raw. A rejected JSON-RPC request can carry a large `data`
    // payload, so the ceiling has to live at the producer.
    wire.respond = responder({
      initialize: { capabilities: {} },
      'textDocument/definition': [LOCATION],
      'textDocument/hover': null,
      'textDocument/implementation': new Error(
        `boom\n${'payload '.repeat(5000)}\n\ttrailing detail`
      ),
    });

    const result = await inspect();

    const failure = result.queryFailures?.[0];
    expect(failure?.query).toBe('implementation');
    expect(failure?.reason).toBe('error');
    // One line, so the `query_unanswered: … | reason=… | …` record shape holds.
    expect(failure?.message).not.toMatch(/[\n\r]/u);
    expect(failure?.message.length).toBeLessThan(400);
    expect(failure?.message).toContain('detail chars omitted');
  });

  it('marks the diagnostics leg unanswered when the server never publishes', async () => {
    wire.publish = null;
    wire.respond = responder({
      initialize: { capabilities: {} },
      'textDocument/definition': [LOCATION],
      'textDocument/hover': null,
      'textDocument/implementation': [],
    });

    const result = await inspect();

    expect(result.available).toBe(true);
    expect(result.definition?.length).toBe(1);
    expect(result.queryFailures).toEqual([
      expect.objectContaining({ query: 'diagnostics', reason: 'timeout' }),
    ]);
  });
});
