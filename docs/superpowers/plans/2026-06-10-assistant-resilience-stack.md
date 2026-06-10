# Assistant Resilience Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live Mastra assistant stream resilient to hanging tools and stalled streams without regressing real hosted-provider tool execution.

**Architecture:** Keep the renderer safety net intact, then wire the existing agent-package resilience utilities into the real Mastra runtime only after real-loop tests prove the current gap. Tool execution guards belong at the combined Mastra tool map boundary; stream inactivity belongs around the raw Mastra stream iterator.

**Tech Stack:** TypeScript, Vitest, Mastra `Agent`, `@ai-sdk/provider` `LanguageModelV2`, pnpm workspaces.

---

## Scope

This plan implements opportunity 1 from `docs/codebase-refinement-opportunities-2026-06-10.md`.

In scope:

- Real Mastra-loop tests in `packages/agent/src/__tests__/mastra-tool-execution.spec.ts`.
- Strict resilience config in `packages/agent/src/config/resilience-config.ts`.
- Production wiring in `packages/agent/src/mastra/agent-runtime.ts` and `packages/agent/src/mastra/mcp-tool-loader.ts`.
- Package docs/architecture update only if the resilience layers become live.

Out of scope:

- UI rendering changes.
- New public runtime-data fields.
- Model/provider catalog changes.
- MCP discovery timeout behavior.
- Replacing Mastra APIs.

## Files

- Modify: `packages/agent/src/__tests__/mastra-tool-execution.spec.ts`
- Modify: `packages/agent/src/config/resilience-config.ts`
- Modify: `packages/agent/src/mastra/agent-runtime.ts`
- Modify: `packages/agent/src/mastra/mcp-tool-loader.ts`
- Modify: `AGENTS.md` after production wiring is verified

## Task 1: Add Real-Loop Coverage For Hanging Tool Execution

**Files:**

- Modify: `packages/agent/src/__tests__/mastra-tool-execution.spec.ts`

- [ ] **Step 1: Write the failing test**

Add a test inside `describe('mastra real tool execution (real @mastra/core/agent)', ...)` that uses the existing `createScriptedToolCallModel` helper, a real `createTool`, and a tool `execute` that never resolves.

The test must set short strict env values, iterate the real `streamMastraAgent` result, and assert that the run terminates with a structured timeout result instead of hanging.

```ts
it('terminates the real agent loop when a tool execute never resolves', async () => {
  const previousToolTimeout = process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS;
  const previousStreamInactivity = process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS;
  process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS = '20';
  process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS = '200';
  try {
    const executeSpy = vi.fn(() => new Promise(() => {}));
    const hangingTool = createTool({
      id: 'hang_forever',
      description: 'Never returns.',
      inputSchema: z.object({ reason: z.string() }),
      execute: executeSpy,
    });

    modelHolder.current = createScriptedToolCallModel({
      toolName: 'hang_forever',
      toolCallId: 'call-hang-1',
      input: JSON.stringify({ reason: 'test' }),
      finalText: 'The tool timed out.',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u-timeout', role: 'user', parts: [{ type: 'text', text: 'hang?' }] }],
      {
        runtime: { provider: 'openai', apiKey: 'test-key' },
        tools: { hang_forever: hangingTool },
      }
    );

    const chunks: StreamChunk[] = [];
    await expect(
      Promise.race([
        (async () => {
          for await (const chunk of iterator) {
            chunks.push(chunk);
          }
          return 'completed' as const;
        })(),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
      ])
    ).resolves.toBe('completed');

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const runEventKinds = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(runEventKinds).toContain('tool.completed');
    expect(JSON.stringify(chunks)).toContain('tool_timeout');
  } finally {
    if (previousToolTimeout === undefined) {
      delete process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS;
    } else {
      process.env.BRAINSTRIKE_TOOL_TIMEOUT_MS = previousToolTimeout;
    }
    if (previousStreamInactivity === undefined) {
      delete process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS;
    } else {
      process.env.BRAINSTRIKE_STREAM_INACTIVITY_MS = previousStreamInactivity;
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @brainstrike/agent exec vitest run src/__tests__/mastra-tool-execution.spec.ts --no-file-parallelism
```

Expected: FAIL. The new test should fail because the current real agent loop does not guard the hanging tool execution, so the local race returns `timed-out`.

- [ ] **Step 3: Do not edit production code yet**

Confirm the failure is the expected missing-guard behavior, not a syntax error, import error, or mocked Mastra path.

## Task 2: Resolve Resilience Config Once Per Runtime

**Files:**

- Modify: `packages/agent/src/config/resilience-config.ts`
- Modify: `packages/agent/src/mastra/agent-runtime.ts`

- [ ] **Step 1: Write config tests**

Add tests to `packages/agent/src/config/__tests__/resilience-config.spec.ts` for:

- default `{ toolTimeoutMs: 60000, streamInactivityMs: 120000 }`
- env overrides
- malformed values throw
- `toolTimeoutMs >= streamInactivityMs` throws

- [ ] **Step 2: Run config tests and verify they fail for the missing aggregate resolver**

Run:

```bash
pnpm --filter @brainstrike/agent exec vitest run src/config/__tests__/resilience-config.spec.ts --no-file-parallelism
```

Expected: FAIL for the missing aggregate resolver/invariant.

- [ ] **Step 3: Implement the minimal aggregate resolver**

Add a `resolveAssistantResilienceConfig()` export that calls the existing strict resolvers and enforces `toolTimeoutMs < streamInactivityMs`.

```ts
export interface AssistantResilienceConfig {
  streamInactivityMs: number;
  toolTimeoutMs: number;
}
```

- [ ] **Step 4: Run config tests and verify they pass**

Run:

```bash
pnpm --filter @brainstrike/agent exec vitest run src/config/__tests__/resilience-config.spec.ts --no-file-parallelism
```

Expected: PASS.

## Task 3: Guard Combined Mastra Tools

**Files:**

- Modify: `packages/agent/src/mastra/mcp-tool-loader.ts`
- Modify: `packages/agent/src/mastra/agent-runtime.ts`

- [ ] **Step 1: Wire the guard at the combined-tool boundary**

Call `applyToolGuards` after `collectCombinedTools` returns the full sanitized local + MCP tool map. Use the resolved tool timeout from `resolveAssistantResilienceConfig()`.

- [ ] **Step 2: Preserve tool output bounding**

Do not remove `wrapMcpToolOutputs`. MCP output bounding must still run before or inside the guarded execution path so oversized MCP output remains bounded.

- [ ] **Step 3: Run the real-loop hanging-tool test**

Run:

```bash
pnpm --filter @brainstrike/agent exec vitest run src/__tests__/mastra-tool-execution.spec.ts --no-file-parallelism
```

Expected: PASS for the hanging-tool case and existing real-loop cases.

## Task 4: Wrap The Raw Mastra Stream With The Inactivity Watchdog

**Files:**

- Modify: `packages/agent/src/__tests__/mastra-tool-execution.spec.ts`
- Modify: `packages/agent/src/mastra/agent-runtime.ts`

- [ ] **Step 1: Add a real-loop stalled-stream test**

Add a test where the fake `LanguageModelV2.doStream()` returns a stream that emits `stream-start` and never closes. Use `BRAINSTRIKE_STREAM_INACTIVITY_MS = '30'` and assert that `streamMastraAgent` terminates with a visible error finish instead of hanging.

- [ ] **Step 2: Run the real-loop spec and verify the new test fails**

Run:

```bash
pnpm --filter @brainstrike/agent exec vitest run src/__tests__/mastra-tool-execution.spec.ts --no-file-parallelism
```

Expected: FAIL because `streamChunksFromMastra` currently iterates `readableStreamIterator(...)` directly.

- [ ] **Step 3: Wrap `readableStreamIterator(...)` with `withInactivityTimeout(...)`**

Resolve the inactivity timeout once for the stream and wrap the iterator in `streamChunksFromMastra`. Convert `StreamStalledError` into a visible error message, `run.failed`, and an error finish. Keep cleanup in `finally`.

- [ ] **Step 4: Run the real-loop spec again**

Run:

```bash
pnpm --filter @brainstrike/agent exec vitest run src/__tests__/mastra-tool-execution.spec.ts --no-file-parallelism
```

Expected: PASS.

## Task 5: Update Architecture Documentation

**Files:**

- Modify: `AGENTS.md`

- [ ] **Step 1: Update the ASSISTANT RESILIENCE section**

Replace the warning that the guard and watchdog are utility-only with the verified live state. Preserve the historical warning that real Mastra-loop coverage is required before future rewiring.

- [ ] **Step 2: Include validation evidence**

Document the real-loop spec that proves hosted-style tool execution still invokes real `execute`.

- [ ] **Step 3: Run targeted docs diff review**

Run:

```bash
git diff -- AGENTS.md
```

Expected: the section says what is live now and does not overclaim broader end-to-end desktop validation.

## Task 6: Validate And Commit Stack 1

**Files:**

- All files modified by Tasks 1-5.

- [ ] **Step 1: Run targeted package checks**

Run:

```bash
pnpm --filter @brainstrike/agent exec vitest run src/__tests__/mastra-tool-execution.spec.ts src/config/__tests__/resilience-config.spec.ts src/__tests__/guard-tool-execution.spec.ts src/__tests__/with-inactivity-timeout.spec.ts --no-file-parallelism
pnpm --filter @brainstrike/agent type-check
```

Expected: PASS.

- [ ] **Step 2: Run root CI-parity gates before PR**

Run:

```bash
pnpm lint:ci
pnpm type-check
pnpm build
pnpm test
```

Expected: PASS in the same final run.

- [ ] **Step 3: Commit**

Run:

```bash
git add AGENTS.md packages/agent/src/__tests__/mastra-tool-execution.spec.ts packages/agent/src/config/__tests__/resilience-config.spec.ts packages/agent/src/config/resilience-config.ts packages/agent/src/mastra/agent-runtime.ts packages/agent/src/mastra/mcp-tool-loader.ts docs/superpowers/plans/2026-06-10-assistant-resilience-stack.md
git commit -m "fix(agent): guard assistant tool and stream stalls"
```

Expected: commit created on `codex/refinement-opportunity-1-assistant-resilience`.

## Subagent Use

- Use an explorer subagent for focused codebase questions that do not block the immediate local step.
- Use reviewer subagents after implementation for spec compliance and code quality.
- Do not run parallel worker subagents against overlapping files in this stack.
- Do not push or open a PR until local validation is green.

## Completion Criteria For Stack 1

- Real Mastra-loop hanging tool test fails before production wiring and passes after.
- Real Mastra-loop stalled stream test fails before production wiring and passes after.
- Existing real Mastra-loop tool execution test still proves real `execute` is invoked.
- Guard/watchdog config is strict and enforces `toolTimeoutMs < streamInactivityMs`.
- `AGENTS.md` accurately reflects the live assistant resilience state.
- Local validation gates are green.
