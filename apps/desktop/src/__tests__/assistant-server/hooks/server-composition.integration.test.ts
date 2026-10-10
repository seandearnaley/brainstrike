/**
 * Integration coverage for the desktop hooks server-composition layer:
 * buildHookManager (roots + trust + config), the UserPromptSubmit gate + block
 * short-circuit stream, PostToolUse context, and the terminal Stop hook — all
 * over the REAL HookManager/executor with temp hook scripts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, RuntimeData, StreamChunk } from '@brainstrike/agent';
import { createAssistantRunEvent } from '@brainstrike/agent';
import type {
  HookManager,
  HookRunEventInput,
  HookRunVerdict,
} from '@brainstrike/host-capabilities/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopHookRunner } from '../../../assistant-server/hooks/hook-runner-impl';
import {
  buildHookManager,
  deriveLastUserText,
  installDesktopHookApprovalReader,
  makeHookBlockedStream,
  prepareRequestHooks,
  withStopHook,
} from '../../../assistant-server/hooks/server-integration';
import { enrichRuntimeDataWithWorkspaceRoots } from '../../../assistant-server/workspace-roots';

let tmpRoot: string;
const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};

function writeProjectHooks(rootAbsPath: string, content: string): string {
  const dir = join(rootAbsPath, '.brainstrike');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'hooks.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeHookCommand(rootAbsPath: string, program: string): string {
  const filename = `hook-${randomUUID()}.cjs`;
  writeFileSync(join(rootAbsPath, filename), program, 'utf8');
  // Keep the real native shell; a relative filename needs no temp-path quoting.
  return `node ${filename}`;
}

function writeStdoutHook(rootAbsPath: string, stdout: string, exitCode = 0): string {
  return writeHookCommand(
    rootAbsPath,
    `process.stdout.write(${JSON.stringify(`${stdout}\n`)});\nprocess.exitCode = ${exitCode};\n`
  );
}

function writeStdinHook(rootAbsPath: string, marker: string): string {
  return writeHookCommand(
    rootAbsPath,
    `const { readFileSync, writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(marker)}, readFileSync(0));\n`
  );
}

function runtimeWithRoot(rootId: string, absPath: string): RuntimeData {
  return {
    provider: 'openai',
    workspaceRoots: [{ displayName: 'root', path: absPath, rootId }],
  } as RuntimeData;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bs-hooks-int-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpRoot, { force: true, recursive: true });
});

describe('deriveLastUserText', () => {
  it('returns the last user message text', () => {
    const messages: AgentMessage[] = [
      { id: 'a', parts: [{ text: 'first', type: 'text' }], role: 'user' },
      { id: 'b', parts: [{ text: 'answer', type: 'text' }], role: 'assistant' },
      { id: 'c', parts: [{ text: 'latest', type: 'text' }], role: 'user' },
    ];
    expect(deriveLastUserText(messages)).toBe('latest');
  });
});

describe('makeHookBlockedStream', () => {
  it('yields a visible message, a run.failed event, and an error finish', async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of makeHookBlockedStream('nope')) {
      chunks.push(chunk);
    }
    expect(JSON.stringify(chunks)).toContain('nope');
    const kinds = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'run-event' }> => c.type === 'run-event')
      .map((c) => c.event.kind);
    expect(kinds).toContain('run.failed');
    expect(chunks.some((c) => c.type === 'message-finish' && c.finishReason === 'error')).toBe(
      true
    );
  });
});

describe('buildHookManager (roots + trust + config)', () => {
  it('loads a project root hooks file only when the approved hash matches disk', async () => {
    const config = JSON.stringify({
      PreToolUse: [
        { command: writeStdoutHook(tmpRoot, '{"reason":"blocked"}', 2), type: 'command' },
      ],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const runtimeData = runtimeWithRoot('root-1', tmpRoot);

    // Untrusted (no approval) → hooks are skipped.
    const untrusted = buildHookManager({
      approvedByRoot: new Map(),
      logger,
      runtimeData,
      sessionId: 's1',
    });
    expect(untrusted.hasHooks()).toBe(false);

    // Approved with the matching hash → hooks load + block.
    const approved = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData,
      sessionId: 's1',
    });
    expect(approved.hasHooks()).toBe(true);
    const runner = createDesktopHookRunner(approved);
    const gate = await runner.preToolUse('executeCommand', { cmd: 'ls' });
    expect(gate.decision).toBe('block');
    expect(gate.reason).toBe('blocked');
  });

  it('trusts + loads a root whose hooks file has non-utf8 bytes (M1 hash parity)', () => {
    // Review (approve-time) hash and load-time trust hash must both be of the RAW
    // bytes. A lone 0xFF (invalid UTF-8) inside a string value would diverge a
    // utf8-decoded-string hash from the raw-byte hash → the approval would
    // silently never take. Prove the approved root's hooks load.
    const prefix = Buffer.from(
      '{"PreToolUse":[{"command":"echo \'{\\"reason\\":\\"blocked\\"}\'; exit 2","description":"x',
      'utf8'
    );
    const suffix = Buffer.from('y","type":"command"}]}', 'utf8');
    const bytes = Buffer.concat([prefix, Buffer.from([0xff]), suffix]);
    const dir = join(tmpRoot, '.brainstrike');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'hooks.json');
    writeFileSync(file, bytes);

    // The hash the host trusts == the raw-byte hash.
    const approvedSha = sha256OfFile(file);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', approvedSha]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    expect(manager.hasHooks()).toBe(true);
  });

  it('surfaces a disabled config file via reportConfigErrors (fail-loud)', () => {
    writeProjectHooks(tmpRoot, '{ invalid json');
    const events: HookRunEventInput[] = [];
    const manager = buildHookManager({
      approvedByRoot: new Map([
        ['root-1', sha256OfFile(join(tmpRoot, '.brainstrike', 'hooks.json'))],
      ]),
      emitRunEvent: (e) => events.push(e),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });
    manager.reportConfigErrors();
    expect(events.some((e) => e.kind === 'hook.notice' && e.status === 'failed')).toBe(true);
  });
});

// The legacy server reads trust from the agent host, its one owner: it asks
// only about the request's mounted roots (a disconnected root is not among
// them), and a root's project hooks run only at the hash the host trusts.
describe('prepareRequestHooks reads project hook trust from the agent host', () => {
  it("runs a mounted root's hooks at the host-trusted hash, and none without it", async () => {
    const config = JSON.stringify({
      PreToolUse: [
        { command: writeStdoutHook(tmpRoot, '{"reason":"blocked"}', 2), type: 'command' },
      ],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const asked: unknown[] = [];
    installDesktopHookApprovalReader(async (root) => {
      asked.push(root);
      return root.rootId === 'db-1' ? sha256OfFile(file) : undefined;
    });

    const trusted = await prepareRequestHooks({
      logger,
      runId: 'run-1',
      runtimeData: runtimeWithRoot('db-1', tmpRoot),
    });
    expect(trusted.manager.hasHooks()).toBe(true);
    expect(asked).toEqual([{ absPath: tmpRoot, rootId: 'db-1' }]);

    const untrusted = await prepareRequestHooks({
      logger,
      runId: 'run-2',
      runtimeData: runtimeWithRoot('db-2', tmpRoot),
    });
    expect(untrusted.manager.hasHooks()).toBe(false);
  });
});

// MAIN-ROOT cwd proof: the client-declared main root (runtimeData.mainRootId)
// reorders the enriched workspaceRoots, and buildHookManager's primaryCwd —
// the `cwd` every non-tool hook event (UserPromptSubmit/Stop/Session)
// receives on stdin, and the spawn cwd assigned to GLOBAL hooks — follows
// roots[0]. This is THE behavior change of the main-vs-focused split:
// previously roots[0] was the first-ever-added live DB row.
describe('hooks primaryCwd follows the declared main root (roots[0] after reorder)', () => {
  it('feeds the Stop hook cwd = main root, flipping with the declaration', async () => {
    const rootA = join(tmpRoot, 'root-a');
    const rootB = join(tmpRoot, 'root-b');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    const marker = join(tmpRoot, 'stop-payload.json');
    const config = JSON.stringify({
      Stop: [{ command: writeStdinHook(rootA, marker), type: 'command' }],
    });
    const file = writeProjectHooks(rootA, config);
    const trust = new Map([['db-a', sha256OfFile(file)]]);
    const db = {
      query: vi.fn(async () => ({
        rows: [
          { displayName: 'a', id: 'db-a', path: rootA },
          { displayName: 'b', id: 'db-b', path: rootB },
        ] as never[],
      })),
    };

    const runStopAndReadCwd = async (runtimeData: RuntimeData | undefined): Promise<string> => {
      const manager = buildHookManager({
        approvedByRoot: trust,
        logger,
        runtimeData,
        sessionId: 's1',
      });
      expect(manager.hasHooks()).toBe(true);
      await manager.runStop('complete');
      const payload = JSON.parse(readFileSync(marker, 'utf8')) as { cwd: string };
      return payload.cwd;
    };

    // No declaration → created_at order → primaryCwd = root A.
    const defaultOrder = await enrichRuntimeDataWithWorkspaceRoots(
      { provider: 'openai' } as RuntimeData,
      db
    );
    expect(await runStopAndReadCwd(defaultOrder)).toBe(rootA);

    // Declared main = B → reorder → primaryCwd = root B (same hook, same
    // config root — only the event cwd moved).
    const mainB = await enrichRuntimeDataWithWorkspaceRoots(
      { mainRootId: 'db-b', provider: 'openai' } as RuntimeData,
      db
    );
    expect(mainB?.workspaceRoots?.[0]?.rootId).toBe('db-b');
    expect(await runStopAndReadCwd(mainB)).toBe(rootB);
  });
});

describe('withStopHook', () => {
  it('fires the Stop hook with the resolved reason when the stream completes', async () => {
    const marker = join(tmpRoot, 'stop.json');
    const config = JSON.stringify({
      Stop: [{ command: writeStdinHook(tmpRoot, marker), type: 'command' }],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', value: 'hi' };
    }

    const controller = new AbortController();
    const seen: StreamChunk[] = [];
    for await (const chunk of withStopHook(source(), manager, controller.signal, logger)) {
      seen.push(chunk);
    }

    expect(seen.some((c) => c.type === 'text-delta')).toBe(true);
    const stopPayload = JSON.parse(readFileSync(marker, 'utf8')) as { stop_reason: string };
    expect(stopPayload.stop_reason).toBe('complete');
  });

  it('runs Stop exactly once when the stream carries a message-finish chunk', async () => {
    // The Stop hook APPENDS a line: the once-guard must keep the finish-boundary
    // run and the `finally` run from both firing (a regression that double-fires
    // spawns the subprocess twice → two marker lines).
    const marker = join(tmpRoot, 'runs.txt');
    const command = writeHookCommand(
      tmpRoot,
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run\\n');\n`
    );
    const config = JSON.stringify({
      Stop: [{ command, type: 'command' }],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', value: 'hi' };
      yield {
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 1, promptTokens: 1 },
      };
    }

    const controller = new AbortController();
    for await (const _chunk of withStopHook(source(), manager, controller.signal, logger)) {
      // drain
    }

    const lines = readFileSync(marker, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('passes the accumulated assistant text as assistant_message (bounded tail)', async () => {
    const marker = join(tmpRoot, 'stop-message.json');
    const config = JSON.stringify({
      Stop: [{ command: writeStdinHook(tmpRoot, marker), type: 'command' }],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    // The tail bound must keep the END of an oversized answer — a Stop hook
    // grades the final answer, and the verdict-bearing text is at the end.
    const filler = 'x'.repeat(70 * 1024);
    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', value: filler };
      yield { type: 'text-delta', value: 'The answer is ' };
      yield { type: 'text-delta', value: 'live-grep.ts' };
      yield {
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 1, promptTokens: 1 },
      };
    }

    const controller = new AbortController();
    for await (const _chunk of withStopHook(source(), manager, controller.signal, logger)) {
      // drain
    }

    const stopPayload = JSON.parse(readFileSync(marker, 'utf8')) as {
      assistant_message?: string;
    };
    expect(stopPayload.assistant_message).toBeDefined();
    expect(stopPayload.assistant_message?.endsWith('The answer is live-grep.ts')).toBe(true);
    expect(stopPayload.assistant_message?.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('separates generation steps with a newline so line-anchored graders still match', async () => {
    const marker = join(tmpRoot, 'stop-boundary.json');
    const config = JSON.stringify({
      Stop: [{ command: writeStdinHook(tmpRoot, marker), type: 'command' }],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    // Step 1 text does NOT end in a newline; a non-text chunk (the step
    // boundary) intervenes; step 2 opens with the verdict-bearing line. The
    // accumulated assistant_message must not glue them together.
    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', value: 'Let me search the workspace.' };
      yield {
        event: createAssistantRunEvent({
          kind: 'run.started',
          label: 'step boundary stand-in',
          status: 'running',
        }),
        type: 'run-event',
      };
      yield { type: 'text-delta', value: 'ANSWER: live-grep.ts' };
      yield {
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 1, promptTokens: 1 },
      };
    }

    const controller = new AbortController();
    for await (const _chunk of withStopHook(source(), manager, controller.signal, logger)) {
      // drain
    }

    const stopPayload = JSON.parse(readFileSync(marker, 'utf8')) as {
      assistant_message?: string;
    };
    expect(stopPayload.assistant_message).toBe(
      'Let me search the workspace.\nANSWER: live-grep.ts'
    );
    expect(/^ANSWER: live-grep\.ts$/m.test(stopPayload.assistant_message ?? '')).toBe(true);
  });

  it('omits assistant_message when the stream produced no text', async () => {
    const marker = join(tmpRoot, 'stop-no-text.json');
    const config = JSON.stringify({
      Stop: [{ command: writeStdinHook(tmpRoot, marker), type: 'command' }],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    async function* source(): AsyncIterable<StreamChunk> {
      yield {
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      };
    }

    const controller = new AbortController();
    for await (const _chunk of withStopHook(source(), manager, controller.signal, logger)) {
      // drain
    }

    const stopPayload = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>;
    expect(Object.hasOwn(stopPayload, 'assistant_message')).toBe(false);
  });

  it('passes stop_reason "error" when the finish chunk is an error finish', async () => {
    const marker = join(tmpRoot, 'stop-error.json');
    const config = JSON.stringify({
      Stop: [{ command: writeStdinHook(tmpRoot, marker), type: 'command' }],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    async function* source(): AsyncIterable<StreamChunk> {
      yield {
        finishReason: 'error',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      };
    }

    const controller = new AbortController();
    for await (const _chunk of withStopHook(source(), manager, controller.signal, logger)) {
      // drain
    }

    const stopPayload = JSON.parse(readFileSync(marker, 'utf8')) as { stop_reason: string };
    expect(stopPayload.stop_reason).toBe('error');
  });

  it('passes stop_reason "error" when the source stream throws before an error finish', async () => {
    // A throw from the model stream (no terminal error `message-finish` reached)
    // is a FAILED turn: the finally-path Stop hook must report `error`, not the
    // default `complete`.
    const marker = join(tmpRoot, 'stop-throw.json');
    const config = JSON.stringify({
      Stop: [{ command: writeStdinHook(tmpRoot, marker), type: 'command' }],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', value: 'partial' };
      throw new Error('provider stream exploded');
    }

    const controller = new AbortController();
    await expect(async () => {
      for await (const _chunk of withStopHook(source(), manager, controller.signal, logger)) {
        // drain until the throw propagates
      }
    }).rejects.toThrow('provider stream exploded');

    const stopPayload = JSON.parse(readFileSync(marker, 'utf8')) as { stop_reason: string };
    expect(stopPayload.stop_reason).toBe('error');
  });

  it('records a hook-reported run verdict BEFORE the finish chunk is yielded', async () => {
    // The verdict write must not race the run's terminal bookkeeping: awaiting
    // the recorder in FRONT of the `message-finish` yield guarantees the label
    // lands before the caller's post-stream status write can run.
    const config = JSON.stringify({
      Stop: [
        {
          command: writeStdoutHook(
            tmpRoot,
            'test output line\n{"brainstrikeRunVerdict":{"verdict":"failed","detail":"3 tests failing"}}'
          ),
          type: 'command',
        },
      ],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', value: 'hi' };
      yield {
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 1, promptTokens: 1 },
      };
    }

    const recorded: HookRunVerdict[] = [];
    let recordedBeforeFinish = false;
    const onRunVerdict = async (verdict: HookRunVerdict): Promise<void> => {
      // Resolve on a later tick so an un-awaited (fire-and-forget) recorder
      // could not fake the ordering assertion below.
      await new Promise((resolve) => setImmediate(resolve));
      recorded.push(verdict);
    };

    const controller = new AbortController();
    for await (const chunk of withStopHook(
      source(),
      manager,
      controller.signal,
      logger,
      onRunVerdict
    )) {
      if (chunk.type === 'message-finish') {
        recordedBeforeFinish = recorded.length === 1;
      }
    }

    expect(recorded).toEqual([{ detail: '3 tests failing', verdict: 'failed' }]);
    expect(recordedBeforeFinish).toBe(true);
  });

  it('records the verdict when the stream ends without a finish chunk (finally path)', async () => {
    const config = JSON.stringify({
      Stop: [
        {
          command: writeStdoutHook(tmpRoot, '{"brainstrikeRunVerdict":{"verdict":"succeeded"}}'),
          type: 'command',
        },
      ],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', value: 'hi' };
    }

    const recorded: HookRunVerdict[] = [];
    const controller = new AbortController();
    for await (const _chunk of withStopHook(source(), manager, controller.signal, logger, (v) => {
      recorded.push(v);
      return Promise.resolve();
    })) {
      // drain
    }

    expect(recorded).toEqual([{ verdict: 'succeeded' }]);
  });

  it('surfaces a malformed verdict line as a visible notice and never fails the run', async () => {
    const config = JSON.stringify({
      Stop: [
        {
          command: writeStdoutHook(tmpRoot, '{"brainstrikeRunVerdict":{"verdict":"passed"}}'),
          type: 'command',
        },
      ],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const events: HookRunEventInput[] = [];
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      emitRunEvent: (e) => events.push(e),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    async function* source(): AsyncIterable<StreamChunk> {
      yield {
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 1, promptTokens: 1 },
      };
    }

    const recorded: HookRunVerdict[] = [];
    const controller = new AbortController();
    const seen: StreamChunk[] = [];
    for await (const chunk of withStopHook(source(), manager, controller.signal, logger, (v) => {
      recorded.push(v);
      return Promise.resolve();
    })) {
      seen.push(chunk);
    }

    expect(recorded).toEqual([]);
    expect(seen.some((c) => c.type === 'message-finish' && c.finishReason === 'stop')).toBe(true);
    expect(
      events.some(
        (e) => e.kind === 'hook.notice' && (e.detail ?? '').includes('brainstrikeRunVerdict')
      )
    ).toBe(true);
  });

  it('yields the finish chunk even when the verdict recorder rejects (allow-on-fault)', async () => {
    const config = JSON.stringify({
      Stop: [
        {
          command: writeStdoutHook(tmpRoot, '{"brainstrikeRunVerdict":{"verdict":"failed"}}'),
          type: 'command',
        },
      ],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    async function* source(): AsyncIterable<StreamChunk> {
      yield {
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 1, promptTokens: 1 },
      };
    }

    const controller = new AbortController();
    const seen: StreamChunk[] = [];
    for await (const chunk of withStopHook(source(), manager, controller.signal, logger, () =>
      Promise.reject(new Error('db write exploded'))
    )) {
      seen.push(chunk);
    }

    expect(seen.some((c) => c.type === 'message-finish')).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to record hook-reported run verdict',
      expect.anything()
    );
  });

  it('does NOT capture verdict lines from non-Stop hook phases', async () => {
    // Only the run-scoped Stop phase may label the run: a PostToolUse hook that
    // prints the verdict line must not produce a run verdict.
    const config = JSON.stringify({
      PostToolUse: [
        {
          command: writeStdoutHook(tmpRoot, '{"brainstrikeRunVerdict":{"verdict":"failed"}}'),
          type: 'command',
        },
      ],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    const result = await manager.runPostToolUse({
      toolError: false,
      toolInput: {},
      toolName: 'readWorkspaceFile',
      toolOutput: 'ok',
    });
    expect(result.runVerdict).toBeUndefined();
  });

  it('lets the LAST Stop hook with a valid verdict win across multiple hooks', async () => {
    const config = JSON.stringify({
      Stop: [
        {
          command: writeStdoutHook(tmpRoot, '{"brainstrikeRunVerdict":{"verdict":"succeeded"}}'),
          type: 'command',
        },
        {
          command: writeStdoutHook(tmpRoot, '{"brainstrikeRunVerdict":{"verdict":"mixed"}}'),
          type: 'command',
        },
      ],
    });
    const file = writeProjectHooks(tmpRoot, config);
    const manager = buildHookManager({
      approvedByRoot: new Map([['root-1', sha256OfFile(file)]]),
      logger,
      runtimeData: runtimeWithRoot('root-1', tmpRoot),
      sessionId: 's1',
    });

    const result = await manager.runStop('complete');
    expect(result.runVerdict).toEqual({ verdict: 'mixed' });
  });

  it('yields the finish chunk even when the Stop runner throws (allow-on-fault)', async () => {
    // A runner-layer throw at the Stop boundary must NOT eat the finish chunk:
    // the phase degrades to a lost notice, never a lost finish.
    const throwingManager = {
      runStop: vi.fn().mockRejectedValue(new Error('runner boom')),
    } as unknown as HookManager;

    const finish: StreamChunk = {
      finishReason: 'stop',
      path: [],
      type: 'message-finish',
      usage: { completionTokens: 1, promptTokens: 1 },
    };
    async function* source(): AsyncIterable<StreamChunk> {
      yield finish;
    }

    const controller = new AbortController();
    const seen: StreamChunk[] = [];
    for await (const chunk of withStopHook(source(), throwingManager, controller.signal, logger)) {
      seen.push(chunk);
    }

    expect(seen.some((c) => c.type === 'message-finish')).toBe(true);
    expect(logger.error).toHaveBeenCalledWith('Stop hook phase failed', expect.anything());
  });
});
