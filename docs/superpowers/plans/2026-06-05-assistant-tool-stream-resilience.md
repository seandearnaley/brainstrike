# Assistant Tool & Stream Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the assistant's tool→stream chain "rock solid" — a hung/erroring tool (internal or MCP) returns a structured error and the run continues; a stalled stream always terminates with a real error+finish; a renderer exception is recoverable without a page refresh.

**Architecture:** Three independently-testable units. (1) `guardToolExecution` wraps every tool's `execute` at the single `collectCombinedTools` choke point, racing it against a timeout and converting timeout/throw into a structured `{ ok:false, error }` result. (2) `withInactivityTimeout` wraps the raw Mastra iterator in `streamChunksFromMastra`; on silence it throws `StreamStalledError`, which rides the existing error-close path so the stream always finalizes. (3) A renderer error boundary + a regression test that an `error` chunk produces a terminal message and re-enables the composer.

**Tech Stack:** TypeScript (strict), Vitest (unit/integration), Playwright (desktop E2E), React 19, Mastra agent runtime, PGlite. pnpm workspaces + Turborepo.

**Timeout ordering (intentional):** `BRAINSTRIKE_TOOL_TIMEOUT_MS` (60s) `<` `BRAINSTRIKE_STREAM_INACTIVITY_MS` (120s) so a hung tool is caught by the guard (run continues) before the watchdog fires.

**Spec:** `docs/superpowers/specs/2026-06-05-assistant-tool-stream-resilience-design.md`

**Conventions verified in repo:**
- Agent tests live in `packages/agent/src/__tests__/*.spec.ts` (e.g. `readable-stream-iterator.spec.ts`).
- Run a single agent test: `cd packages/agent && pnpm vitest run src/__tests__/<file>.spec.ts`.
- Full local gate (AGENTS.md): build + lint + type-check + unit/integration must pass together before opening the PR.
- Commit format ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `packages/agent/src/config/resilience-config.ts` | Strict env parsing + defaults for the two timeouts | New |
| `packages/agent/src/config/__tests__/resilience-config.spec.ts` | Tests for strict parsing | New |
| `packages/agent/src/tools/guard-tool-execution.ts` | Per-tool execute guard → structured error result; `isGuardedToolError` type guard | New |
| `packages/agent/src/__tests__/guard-tool-execution.spec.ts` | Guard unit tests (timeout, throw, passthrough) | New |
| `packages/agent/src/stream/with-inactivity-timeout.ts` | Async-iterator inactivity watchdog; `StreamStalledError` | New |
| `packages/agent/src/__tests__/with-inactivity-timeout.spec.ts` | Watchdog unit tests | New |
| `packages/agent/src/mastra/mcp-tool-loader.ts` | Route the final `combined` tools map through the guard | Modify (~line 78) |
| `packages/agent/src/mastra/agent-runtime.ts` | Wrap the Mastra iterator with the watchdog; reclassify guarded-error tool results to `tool.failed` | Modify (~line 1060, ~line 493) |
| `packages/agent/src/__tests__/data-stream-stall.spec.ts` | Integration: session closes on stall; user-cancel stays silent | New |
| `packages/ui/src/assistant-ui-panel/assistant-panel-error-boundary.tsx` | React error boundary with reset affordance | New |
| `packages/ui/src/assistant-ui-panel/__tests__/assistant-panel-error-boundary.spec.tsx` | Error boundary unit test | New |
| `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` | Mount the error boundary around the thread | Modify |
| `apps/desktop/e2e/assistant-tool-error.spec.ts` | Desktop smoke: tool error → terminal message, composer re-enabled | New (path confirmed against existing e2e dir in Task 9) |

---

## Task 1: Strict timeout configuration

**Files:**
- Create: `packages/agent/src/config/resilience-config.ts`
- Test: `packages/agent/src/config/__tests__/resilience-config.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/src/config/__tests__/resilience-config.spec.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STREAM_INACTIVITY_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  resolveStreamInactivityMs,
  resolveToolTimeoutMs,
} from '../resilience-config';

describe('resilience-config', () => {
  const KEYS = ['BRAINSTRIKE_TOOL_TIMEOUT_MS', 'BRAINSTRIKE_STREAM_INACTIVITY_MS'] as const;
  afterEach(() => {
    for (const key of KEYS) {
      delete process.env[key];
    }
  });

  it('returns documented defaults when env is absent', () => {
    expect(resolveToolTimeoutMs()).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(resolveStreamInactivityMs()).toBe(DEFAULT_STREAM_INACTIVITY_MS);
  });

  it('uses a valid env override', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '30000';
    expect(resolveToolTimeoutMs()).toBe(30_000);
  });

  it('prefers an explicit override argument over env', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '30000';
    expect(resolveToolTimeoutMs(5_000)).toBe(5_000);
  });

  it('throws on a malformed env value (no silent coercion)', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = 'not-a-number';
    expect(() => resolveToolTimeoutMs()).toThrow(/BRAINSTRIKE_TOOL_TIMEOUT_MS/);
  });

  it('throws on a non-positive env value', () => {
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '0';
    expect(() => resolveStreamInactivityMs()).toThrow(/BRAINSTRIKE_STREAM_INACTIVITY_MS/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && pnpm vitest run src/config/__tests__/resilience-config.spec.ts`
Expected: FAIL — `Cannot find module '../resilience-config'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/agent/src/config/resilience-config.ts
/**
 * Strict, no-silent-fallback configuration for assistant resilience timeouts.
 *
 * A *present but malformed* env value throws (typos must not silently coerce);
 * an *absent* value uses the documented default. An explicit override argument
 * always wins, mirroring how `mcpTimeoutMs` is threaded through the runtime.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const DEFAULT_STREAM_INACTIVITY_MS = 120_000;

function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) {
    return undefined;
  }
  return process.env[name];
}

function resolvePositiveIntMs(
  envName: string,
  defaultValue: number,
  override?: number
): number {
  if (typeof override === 'number') {
    if (!Number.isInteger(override) || override <= 0) {
      throw new Error(`${envName} override must be a positive integer (ms), received ${override}.`);
    }
    return override;
  }
  const raw = readEnv(envName);
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer (ms), received "${raw}".`);
  }
  return parsed;
}

export function resolveToolTimeoutMs(override?: number): number {
  return resolvePositiveIntMs('BRAINSTRIKE_TOOL_TIMEOUT_MS', DEFAULT_TOOL_TIMEOUT_MS, override);
}

export function resolveStreamInactivityMs(override?: number): number {
  return resolvePositiveIntMs(
    'BRAINSTRIKE_STREAM_INACTIVITY_MS',
    DEFAULT_STREAM_INACTIVITY_MS,
    override
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && pnpm vitest run src/config/__tests__/resilience-config.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/config/resilience-config.ts packages/agent/src/config/__tests__/resilience-config.spec.ts
git commit -m "feat(agent): strict resilience timeout config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `guardToolExecution` — structured-error tool guard

**Files:**
- Create: `packages/agent/src/tools/guard-tool-execution.ts`
- Test: `packages/agent/src/__tests__/guard-tool-execution.spec.ts`

**Contract:** Given a tool with an `execute(args)` function, return a clone whose `execute` resolves to the original output on success, or to a `GuardedToolError` on timeout/throw. Never rejects. The structured error is the value the model receives, guaranteeing the Mastra loop continues.

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/src/__tests__/guard-tool-execution.spec.ts
import { describe, expect, it, vi } from 'vitest';
import {
  type GuardedToolError,
  guardToolExecution,
  isGuardedToolError,
} from '../tools/guard-tool-execution';

function makeTool(execute: (...args: unknown[]) => unknown) {
  return { id: 'demo', description: 'd', execute };
}

describe('guardToolExecution', () => {
  it('passes through a successful result unchanged', async () => {
    const tool = guardToolExecution(makeTool(async () => ({ value: 42 })), {
      toolName: 'demo',
      timeoutMs: 1000,
    });
    await expect(tool.execute({ context: {} })).resolves.toEqual({ value: 42 });
  });

  it('returns a structured timeout error when execute never resolves', async () => {
    vi.useFakeTimers();
    const tool = guardToolExecution(
      makeTool(() => new Promise(() => {})),
      { toolName: 'demo', timeoutMs: 50 }
    );
    const promise = tool.execute({ context: {} });
    await vi.advanceTimersByTimeAsync(60);
    const result = (await promise) as GuardedToolError;
    expect(isGuardedToolError(result)).toBe(true);
    expect(result.error.code).toBe('tool_timeout');
    expect(result.error.toolName).toBe('demo');
    vi.useRealTimers();
  });

  it('returns a structured failure error when execute throws, without leaking raw message', async () => {
    const logger = { debug: vi.fn(), error: vi.fn() };
    const tool = guardToolExecution(
      makeTool(() => {
        throw new Error('SECRET internal path /Users/x/.ssh');
      }),
      { toolName: 'demo', timeoutMs: 1000, logger }
    );
    const result = (await tool.execute({ context: {} })) as GuardedToolError;
    expect(result.error.code).toBe('tool_failed');
    expect(result.error.message).not.toContain('SECRET');
    expect(logger.error).toHaveBeenCalled();
  });

  it('leaves a tool without an execute function untouched', () => {
    const noExec = { id: 'x', description: 'd' } as { id: string; description: string };
    expect(guardToolExecution(noExec, { toolName: 'x', timeoutMs: 1000 })).toBe(noExec);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && pnpm vitest run src/__tests__/guard-tool-execution.spec.ts`
Expected: FAIL — `Cannot find module '../tools/guard-tool-execution'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/agent/src/tools/guard-tool-execution.ts
import type { ToolLogger } from './types';

export interface GuardedToolError {
  ok: false;
  error: {
    code: 'tool_timeout' | 'tool_failed';
    message: string;
    toolName: string;
  };
}

const GUARDED_TOOL_ERROR_MESSAGE = 'The tool did not complete successfully. Try another approach.';
const GUARDED_TOOL_TIMEOUT_MESSAGE =
  'The tool timed out before returning a result. Try a smaller request or another approach.';

export function isGuardedToolError(value: unknown): value is GuardedToolError {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { ok?: unknown; error?: { code?: unknown } };
  return (
    candidate.ok === false &&
    typeof candidate.error === 'object' &&
    candidate.error !== null &&
    (candidate.error.code === 'tool_timeout' || candidate.error.code === 'tool_failed')
  );
}

interface ExecutableLike {
  execute: (...args: unknown[]) => unknown;
}

function hasExecute(tool: unknown): tool is ExecutableLike {
  return typeof (tool as { execute?: unknown }).execute === 'function';
}

export interface GuardOptions {
  toolName: string;
  timeoutMs: number;
  logger?: ToolLogger;
}

/**
 * Wrap a Mastra-compatible tool so its `execute` can never freeze or crash the
 * run: on timeout or throw it resolves to a structured {@link GuardedToolError}.
 * Non-executable tools are returned unchanged.
 */
export function guardToolExecution<T>(tool: T, options: GuardOptions): T {
  if (!hasExecute(tool)) {
    return tool;
  }
  const original = tool.execute;
  const { toolName, timeoutMs, logger } = options;

  const cloned = Object.create(Object.getPrototypeOf(tool)) as ExecutableLike;
  Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(tool));

  cloned.execute = async (...args: unknown[]): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GuardedToolError>((resolve) => {
      timer = setTimeout(() => {
        logger?.error('Tool execution timed out', { toolName, timeoutMs });
        resolve({ ok: false, error: { code: 'tool_timeout', message: GUARDED_TOOL_TIMEOUT_MESSAGE, toolName } });
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });

    try {
      const run = (async () => Reflect.apply(original, cloned, args))();
      return await Promise.race([run, timeout]);
    } catch (error) {
      logger?.error('Tool execution failed', { toolName, error });
      return { ok: false, error: { code: 'tool_failed', message: GUARDED_TOOL_ERROR_MESSAGE, toolName } };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  return cloned as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && pnpm vitest run src/__tests__/guard-tool-execution.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools/guard-tool-execution.ts packages/agent/src/__tests__/guard-tool-execution.spec.ts
git commit -m "feat(agent): per-tool execution guard with structured errors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `withInactivityTimeout` — stream watchdog

**Files:**
- Create: `packages/agent/src/stream/with-inactivity-timeout.ts`
- Test: `packages/agent/src/__tests__/with-inactivity-timeout.spec.ts`

**Contract:** Wrap an async iterable; race each `next()` against an inactivity timer reset on every yielded item. On timeout, throw `StreamStalledError`. Pass items through unchanged; complete normally when the source completes.

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/src/__tests__/with-inactivity-timeout.spec.ts
import { describe, expect, it } from 'vitest';
import { StreamStalledError, withInactivityTimeout } from '../stream/with-inactivity-timeout';

async function* immediate(values: number[]): AsyncIterableIterator<number> {
  for (const value of values) {
    yield value;
  }
}

async function* stallAfterFirst(): AsyncIterableIterator<number> {
  yield 1;
  await new Promise(() => {}); // never resolves
}

describe('withInactivityTimeout', () => {
  it('passes through all items when the source is active', async () => {
    const out: number[] = [];
    for await (const value of withInactivityTimeout(immediate([1, 2, 3]), 1000)) {
      out.push(value);
    }
    expect(out).toEqual([1, 2, 3]);
  });

  it('throws StreamStalledError when the source goes silent', async () => {
    const out: number[] = [];
    await expect(async () => {
      for await (const value of withInactivityTimeout(stallAfterFirst(), 30)) {
        out.push(value);
      }
    }).rejects.toBeInstanceOf(StreamStalledError);
    expect(out).toEqual([1]); // the pre-stall item was delivered
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && pnpm vitest run src/__tests__/with-inactivity-timeout.spec.ts`
Expected: FAIL — `Cannot find module '../stream/with-inactivity-timeout'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/agent/src/stream/with-inactivity-timeout.ts
export class StreamStalledError extends Error {
  readonly code = 'stream_inactivity_timeout';
  constructor(public readonly inactivityMs: number) {
    super(`Stream produced no output for ${inactivityMs}ms`);
    this.name = 'StreamStalledError';
  }
}

/**
 * Wrap an async iterable so that a gap longer than `inactivityMs` between items
 * throws {@link StreamStalledError}. The timer resets on every delivered item.
 * Used around the raw Mastra stream so a wedged provider/tool can never freeze
 * the data-stream session forever.
 */
export async function* withInactivityTimeout<T>(
  source: AsyncIterable<T>,
  inactivityMs: number
): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watchdog = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StreamStalledError(inactivityMs)), inactivityMs);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        const result = await Promise.race([iterator.next(), watchdog]);
        if (result.done) {
          return;
        }
        yield result.value;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }
  } finally {
    await iterator.return?.();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent && pnpm vitest run src/__tests__/with-inactivity-timeout.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/stream/with-inactivity-timeout.ts packages/agent/src/__tests__/with-inactivity-timeout.spec.ts
git commit -m "feat(agent): stream inactivity watchdog iterator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire the guard into the tool choke point

**Files:**
- Modify: `packages/agent/src/mastra/mcp-tool-loader.ts` (the `combined` return at ~line 78; imports at top)
- Test: extend `packages/agent/src/__tests__/guard-tool-execution.spec.ts` (or a focused loader test if one exists)

The single place every native + MCP tool passes through is the `combined` map in `collectCombinedTools()`. Route it through the guard just before returning.

- [ ] **Step 1: Write the failing test** (add to `guard-tool-execution.spec.ts`)

```ts
import { applyToolGuards } from '../tools/guard-tool-execution';

describe('applyToolGuards', () => {
  it('guards every executable tool in the map', async () => {
    const tools = {
      a: { id: 'a', description: 'd', execute: () => new Promise(() => {}) },
      b: { id: 'b', description: 'd', execute: async () => ({ ok: true }) },
    };
    const guarded = applyToolGuards(tools, { timeoutMs: 20 });
    const aResult = await guarded.a.execute({ context: {} });
    expect(isGuardedToolError(aResult)).toBe(true);
    await expect(guarded.b.execute({ context: {} })).resolves.toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && pnpm vitest run src/__tests__/guard-tool-execution.spec.ts -t applyToolGuards`
Expected: FAIL — `applyToolGuards is not a function`.

- [ ] **Step 3: Add `applyToolGuards` to `guard-tool-execution.ts`**

```ts
// append to packages/agent/src/tools/guard-tool-execution.ts
export interface ApplyToolGuardsOptions {
  timeoutMs: number;
  logger?: ToolLogger;
}

/** Guard every executable tool in a Mastra tools map (native + MCP). */
export function applyToolGuards<TMap extends Record<string, unknown>>(
  tools: TMap,
  options: ApplyToolGuardsOptions
): TMap {
  const guarded: Record<string, unknown> = {};
  for (const [toolId, tool] of Object.entries(tools)) {
    guarded[toolId] = guardToolExecution(tool, {
      toolName: toolId,
      timeoutMs: options.timeoutMs,
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }
  return guarded as TMap;
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `cd packages/agent && pnpm vitest run src/__tests__/guard-tool-execution.spec.ts -t applyToolGuards`
Expected: PASS.

- [ ] **Step 5: Apply the guard in `collectCombinedTools`**

In `packages/agent/src/mastra/mcp-tool-loader.ts`:

Add the import near the existing tool imports at the top:
```ts
import { applyToolGuards } from '../tools/guard-tool-execution';
import { resolveToolTimeoutMs } from '../config/resilience-config';
```

Add an optional field to `CollectCombinedToolsOptions` (find the interface in the same file) so the timeout can be overridden:
```ts
  /** Override for the per-tool execution timeout (ms). Defaults to env/config. */
  toolTimeoutOverrideMs?: number;
```

Replace the final `return combined;` (currently ~line 78) with:
```ts
  return applyToolGuards(combined, {
    timeoutMs: resolveToolTimeoutMs(timeoutOverrideMsForTools),
    logger,
  });
```
…and destructure `toolTimeoutOverrideMs: timeoutOverrideMsForTools` in the function params. If the module has no `logger` in scope, omit the `logger` field (the loader already imports a module-level `logger`; reuse it as `{ logger }` only if its shape matches `ToolLogger` — it does: `debug`/`error`). Pass `logger` only if available.

NOTE: there are **two** early `return combined;` paths (no mcpClient; no named servers). Guard those too — simplest is to compute the guarded map once at the end and have all early returns fall through to a single guarded return. Refactor the three `return combined;` sites to assign and break to one final guarded return, OR wrap each. Prefer a single exit: introduce the guarded return only at the end and change early `return combined;` to `return applyToolGuards(combined, { timeoutMs: resolveToolTimeoutMs(timeoutOverrideMsForTools), logger });`. Keep it DRY with a local `const guard = (t) => applyToolGuards(t, {...});`.

- [ ] **Step 6: Type-check + run the agent suite**

Run: `cd packages/agent && pnpm vitest run && pnpm -w run type-check --filter @brainstrike/agent`
(If the repo type-check command differs, use the package's `tsc --build`.)
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/tools/guard-tool-execution.ts packages/agent/src/__tests__/guard-tool-execution.spec.ts packages/agent/src/mastra/mcp-tool-loader.ts
git commit -m "feat(agent): guard all combined tools (native + MCP) at the choke point

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire the watchdog into the Mastra stream + reclassify guarded errors

**Files:**
- Modify: `packages/agent/src/mastra/agent-runtime.ts` (the `for await` at ~line 1060; the `success` case in `makeToolLifecycleRunEventChunk` at ~line 493)

- [ ] **Step 1: Wrap the raw iterator with the watchdog**

In `streamChunksFromMastra` (~line 1060), change:
```ts
for await (const part of readableStreamIterator(stream, runtimeData?.signal)) {
```
to:
```ts
for await (const part of withInactivityTimeout(
  readableStreamIterator(stream, runtimeData?.signal),
  resolveStreamInactivityMs(runtimeData?.streamInactivityMs)
)) {
```

Add imports at the top of the file:
```ts
import { withInactivityTimeout } from '../stream/with-inactivity-timeout';
import { resolveStreamInactivityMs } from '../config/resilience-config';
```

`runtimeData?.streamInactivityMs` is optional; if `RuntimeData` has no such field, pass `undefined` (i.e. `resolveStreamInactivityMs()`) and skip adding the field. Adding the field is optional polish — keep this task minimal by using `resolveStreamInactivityMs()` with no argument unless the field already exists.

The `StreamStalledError` thrown here propagates out of `streamChunksFromMastra` → `consumeSource` → `startProcessing`'s `catch` → `mapper.handleError` (emits an `error` chunk) → `finally → finalizeStream` (emits finish). The existing `finally` in `streamChunksFromMastra` runs `runtime?.dispose()`, cancelling the Mastra run. No new finalize logic required. (Proven by Task 6.)

- [ ] **Step 2: Reclassify guarded-error tool results to `tool.failed`**

A guarded failure returns a *value* (not a throw), so Mastra emits a `success` tool-result whose payload is the `GuardedToolError`. Without this step the timeline would mislabel it "completed". In `makeToolLifecycleRunEventChunk`, `case 'success'` (~line 493), before the `terminalToolCallStates.set(toolCallId, 'completed')` branch, add:

```ts
      if (isGuardedToolError(toolEvent.payload)) {
        if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
          return;
        }
        lifecycleState.terminalToolCallStates.set(toolCallId, 'failed');
        lifecycleState.outputOnlyToolEvents.delete(toolCallId);
        return makeRunEventChunk('tool.failed', 'failed', 'Tool failed', metadata);
      }
```
(Place it after the `tool-output` early-return block so output-only events are unaffected, and before the `'completed'` assignment.)

Add import:
```ts
import { isGuardedToolError } from '../tools/guard-tool-execution';
```

- [ ] **Step 3: Type-check + run the agent suite**

Run: `cd packages/agent && pnpm vitest run`
Expected: existing tests still PASS (regressions caught here).

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/mastra/agent-runtime.ts
git commit -m "feat(agent): inactivity watchdog on Mastra stream + tool.failed reclassification

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Integration — session closes on stall, user-cancel stays silent

**Files:**
- Create: `packages/agent/src/__tests__/data-stream-stall.spec.ts`

This is the headline guarantee: a stalled source must always close the stream. We drive `withInactivityTimeout` through the real `AssistantDataStreamSession` error path.

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/src/__tests__/data-stream-stall.spec.ts
import { describe, expect, it } from 'vitest';
import { AssistantDataStreamSession } from '../stream/data-stream';
import { withInactivityTimeout } from '../stream/with-inactivity-timeout';
import type { StreamChunk } from '../types';

async function* stallingSource(): AsyncIterableIterator<StreamChunk> {
  yield { type: 'text-delta', value: 'partial' };
  await new Promise(() => {}); // never resolves
}

async function drain(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value);
  }
  return text;
}

describe('data-stream stall handling', () => {
  it('closes the session with an error+finish when the source stalls', async () => {
    const source = withInactivityTimeout(stallingSource(), 30);
    const session = new AssistantDataStreamSession(source, () => {});
    const body = await drain(session.createResponse());
    expect(session.isClosed()).toBe(true);
    // The data-stream protocol encodes an error part; assert the wire contains it.
    expect(body).toMatch(/error/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && pnpm vitest run src/__tests__/data-stream-stall.spec.ts`
Expected: BEFORE Task 5's watchdog existed this would hang; with `withInactivityTimeout` it should now pass. If `isClosed()` is false or the body lacks an error marker, adjust the assertion to the actual encoded error code from `data-stream-codes.ts` (read it and match the exact prefix). This step PROVES the chain closes.

- [ ] **Step 3: Make it pass**

If the body assertion is too loose/strict, read `packages/agent/src/stream/data-stream-codes.ts` and `data-stream-mapper.ts` `handleError` to assert the exact encoded error chunk prefix. No production code change expected — Task 5 already wired the behavior.

- [ ] **Step 4: Add the user-cancel-stays-silent test**

```ts
  it('does not emit a stall error when the client cancels', async () => {
    async function* slowButAlive(): AsyncIterableIterator<StreamChunk> {
      yield { type: 'text-delta', value: 'a' };
      yield { type: 'text-delta', value: 'b' };
    }
    const session = new AssistantDataStreamSession(slowButAlive(), () => {});
    const response = session.createResponse();
    await response.body!.cancel(); // simulates user stop
    expect(session.isClosed()).toBe(true);
  });
```

Run: `cd packages/agent && pnpm vitest run src/__tests__/data-stream-stall.spec.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/__tests__/data-stream-stall.spec.ts
git commit -m "test(agent): stalled stream always closes; user-cancel stays silent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Renderer error boundary

**Files:**
- Create: `packages/ui/src/assistant-ui-panel/assistant-panel-error-boundary.tsx`
- Test: `packages/ui/src/assistant-ui-panel/__tests__/assistant-panel-error-boundary.spec.tsx`
- Modify: `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` (wrap the thread render)

- [ ] **Step 1: Write the failing test**

```tsx
// packages/ui/src/assistant-ui-panel/__tests__/assistant-panel-error-boundary.spec.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantPanelErrorBoundary } from '../assistant-panel-error-boundary';

function Boom(): never {
  throw new Error('render exploded');
}

describe('AssistantPanelErrorBoundary', () => {
  it('renders a recoverable fallback instead of a dead tree', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AssistantPanelErrorBoundary>
        <Boom />
      </AssistantPanelErrorBoundary>
    );
    expect(screen.getByText(/assistant panel hit an error/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
    spy.mockRestore();
  });

  it('recovers after reset when children no longer throw', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    function Maybe() {
      if (shouldThrow) {
        throw new Error('boom');
      }
      return <div>recovered</div>;
    }
    render(
      <AssistantPanelErrorBoundary>
        <Maybe />
      </AssistantPanelErrorBoundary>
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ui && pnpm vitest run src/assistant-ui-panel/__tests__/assistant-panel-error-boundary.spec.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the error boundary**

```tsx
// packages/ui/src/assistant-ui-panel/assistant-panel-error-boundary.tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('AssistantPanelErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: (reset: () => void, error: Error) => ReactNode;
}

interface State {
  error: Error | null;
}

export class AssistantPanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error('Assistant panel render error', {
      error: error.message,
      componentStack: info.componentStack,
    });
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback(this.reset, error);
      }
      return (
        <div className="flex flex-col items-start gap-2 p-4 text-sm" role="alert">
          <p>The assistant panel hit an error and stopped rendering.</p>
          <button
            className="rounded-md border border-border px-3 py-1"
            onClick={this.reset}
            type="button"
          >
            Reset panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/ui && pnpm vitest run src/assistant-ui-panel/__tests__/assistant-panel-error-boundary.spec.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount it around the thread**

In `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx`, import the boundary and wrap the top-level returned thread element of `AssistantUiPanel` (the outermost JSX it returns) with `<AssistantPanelErrorBoundary>…</AssistantPanelErrorBoundary>`. Keep providers/runtime outside the boundary if they own the reset-able state; wrap only the visual thread subtree (`ChatThreadUI` and friends).

```tsx
import { AssistantPanelErrorBoundary } from './assistant-panel-error-boundary';
// ...wrap the rendered thread:
return <AssistantPanelErrorBoundary>{/* existing thread JSX */}</AssistantPanelErrorBoundary>;
```

- [ ] **Step 6: Type-check + run the ui suite**

Run: `cd packages/ui && pnpm vitest run src/assistant-ui-panel`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/assistant-ui-panel/assistant-panel-error-boundary.tsx packages/ui/src/assistant-ui-panel/__tests__/assistant-panel-error-boundary.spec.tsx packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx
git commit -m "feat(ui): assistant panel error boundary with reset

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Renderer terminal-error regression test

**Files:**
- Inspect: `packages/ui/src/assistant-ui-panel/data-stream-runtime.ts` and `local-runtime-adapter.ts`
- Test: add to an existing adapter test or create `packages/ui/src/assistant-ui-panel/__tests__/runtime-error-surfacing.spec.ts`

**Goal:** Prove a stream `error` chunk becomes a terminal assistant state (message shown, composer re-enabled), not a perpetual spinner. If the adapters already handle this, the test is a green regression guard; if not, fix the adapter.

- [ ] **Step 1: Read the adapters' error handling**

Read how `data-stream-runtime.ts` handles a decoded `error` part (search for `error` in the `unstable_toolResultStream`/chunk handling) and how `local-runtime-adapter.ts` resolves on a thrown/aborted backend. Identify the observable signal for "run finished with error" (e.g. runtime state transitions to not-running).

- [ ] **Step 2: Write a test asserting the observable terminal state**

Write a focused test that feeds an `error` data-stream chunk (or simulates a backend throw for the local adapter) and asserts the runtime reports a non-running, errored terminal state. Use the exact API surface discovered in Step 1 (e.g. the adapter's returned status/store). Keep it deterministic — no real network/model.

- [ ] **Step 3: Run; if it fails, fix the adapter**

Run: `cd packages/ui && pnpm vitest run src/assistant-ui-panel/__tests__/runtime-error-surfacing.spec.ts`
If FAIL because the adapter swallows the error or never clears "running": fix the adapter to emit a terminal errored message and clear the running flag, then re-run to GREEN.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/assistant-ui-panel
git commit -m "test(ui): stream error chunk yields terminal state, composer re-enabled

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Desktop Playwright smoke

**Files:**
- Inspect: existing desktop e2e dir (`apps/desktop/e2e/` or `apps/desktop/tests/` — confirm the actual path and a representative existing spec for the launch/fixture pattern)
- Create: `apps/desktop/e2e/assistant-tool-error.spec.ts` (use the confirmed dir)
- Possibly modify: `scripts/test-lanes.mjs` (register the new spec if the lane checker requires it — run `node scripts/test-lanes.mjs check`)

**Goal:** End-to-end proof in real Electron: when a tool fails, the thread shows a terminal error and the composer re-enables — no refresh.

- [ ] **Step 1: Find the e2e harness pattern**

Read an existing desktop Playwright spec to copy: how Electron is launched, how the assistant panel is opened, how a deterministic model/tool is stubbed (look for an existing fixture/test hook, e.g. a `window.__BRAINSTRIKE_*__` test API or a fake provider). Identify the selector pattern (role/text/data-testid per AGENTS.md).

- [ ] **Step 2: Write the smoke test (red)**

Using the discovered harness, write a spec that: opens the assistant, triggers a run where a tool is forced to fail/timeout (via the existing stub mechanism — if none exists, the smallest addition is a test-only tool stub guarded behind an E2E flag), and asserts (a) a terminal error/tool-failed indicator is visible and (b) the composer input is enabled again. Prefer `getByRole`/`getByText`/`getByTestId`.

Run: `cd apps/desktop && pnpm test:e2e <spec>` (use the repo's documented desktop e2e command; AGENTS.md references `pnpm exec playwright test`).
Expected: FAIL initially if the stub/assertions aren't wired; iterate to GREEN.

- [ ] **Step 3: Register lane + run lane check**

Run: `node scripts/test-lanes.mjs check`
If it errors about an unassigned file, add the new spec to the appropriate lane in `scripts/test-lanes.mjs`, then re-run until clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop scripts/test-lanes.mjs
git commit -m "test(desktop): e2e smoke for tool-error terminal state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Full local gate + docs

**Files:**
- Modify: `AGENTS.md` — add a short "Assistant resilience" subsection documenting the two env vars and the guard/watchdog invariants (living-document rule).

- [ ] **Step 1: Run the full suite together (CI parity)**

Run (from repo root): `pnpm build && pnpm lint && pnpm type-check && pnpm test`
(Use the repo's actual root scripts; if turbo, `pnpm turbo run build lint type-check test`.)
Expected: all green in one run. Fix anything red and re-run the whole suite until clean (AGENTS.md gate). Note: `db#test` can be flaky under turbo concurrency — re-run in isolation if it flakes.

- [ ] **Step 2: Document the invariants in AGENTS.md**

Add under a new `## ASSISTANT RESILIENCE` section: the two env vars + defaults, the rule that every tool (native + MCP) is guarded at `collectCombinedTools`, that the stream watchdog throws `StreamStalledError` riding the existing error-close path, and that user-cancel must stay distinct from a stall.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document assistant resilience invariants and env vars

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Push + open PR + monitor CI**

```bash
git push -u origin harden/assistant-tool-stream-resilience
gh pr create --fill --base main
```
Then watch checks: `gh pr checks --watch`. Fix failures and push until green.

---

## Self-Review (completed by author)

- **Spec coverage:** Unit 1 (guard) → Tasks 2,4,5(reclassify); Unit 2 (watchdog) → Tasks 3,5,6; Unit 3 (renderer) → Tasks 7,8,9. Strict config → Task 1. Observability (`tool.failed`) → Task 5 Step 2. Tests (unit+integration+desktop) → Tasks 1,2,3,6,7,8,9. CI gate → Task 10. Docs/living-document → Task 10.
- **Type consistency:** `GuardedToolError`/`isGuardedToolError`/`guardToolExecution`/`applyToolGuards` used consistently across Tasks 2,4,5. `StreamStalledError`/`withInactivityTimeout` consistent across Tasks 3,5,6. `resolveToolTimeoutMs`/`resolveStreamInactivityMs` consistent across Tasks 1,4,5.
- **Known investigate-then-implement spots (not placeholders — they carry exact files, the intended change, and a green/red test):** Task 8 (adapter terminal-error path) and Task 9 (desktop e2e harness) require reading one existing file first because the exact API/selector/stub differs per harness; both specify the file to read, the assertion to make, and the fix-if-red path.
