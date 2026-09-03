# MCP Discovery Skip Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a skipped MCP server visible in the run timeline instead of silently answering with a reduced tool surface.

**Architecture:** `mcp-tool-loader.ts` stops deciding how loudly to report a skip (the `pickMcpDiscoveryLogMethod` substring heuristic is deleted, every skip logs at `warn`) and instead returns structured, content-free `McpDiscoverySkip[]` alongside the tool map. `MastraAgentRuntime` carries them like the existing `tokenDiagnostics`/`toolDiscovery` fields. The streaming layer mints one durable `mcp.tools.unavailable` run event per skip, on fresh turns only.

**Tech Stack:** TypeScript strict, Vitest, pnpm workspaces (Turborepo), Mastra agent runtime.

Spec: `docs/superpowers/specs/2026-09-02-mcp-discovery-skip-visibility-design.md`

## Global Constraints

- TypeScript strict. Never `any` — prefer `unknown` + narrowing. Annotate params and return types.
- NO SILENT FALLBACKS. No coercion, no quiet degradation.
- The 5s `DEFAULT_MCP_TIMEOUT_MS` is **not changed** by this plan. Neither is the fact that no production caller supplies `mcpTimeoutMs`.
- The run event kind is exactly `mcp.tools.unavailable`, status exactly `'failed'`.
- `MAX_MCP_DISCOVERY_REASON_CHARS = 200`.
- Object properties and interface members sorted alphabetically (Biome/Ultracite enforce this).
- Run `pnpm dlx ultracite fix` before committing.
- Filenames kebab-case.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/agent/src/mastra/mcp-discovery-diagnostics.ts` | **New.** Owns the `McpDiscoverySkip` type, the reason bounder, and the run-event chunk minting. Kept separate so `stream-run-event-chunks.ts` (documented as the leaf every streaming concern depends on) gains no dependency on the MCP loader. |
| `packages/agent/src/mastra/mcp-tool-loader.ts` | Detects skips and reports them as data. Loses `pickMcpDiscoveryLogMethod` and `logMcpDiscoverySkip`. |
| `packages/agent/src/mastra/runtime-assembly/tool-pipeline.ts` | Threads `mcpDiscoverySkips` through `RuntimeToolMapResult`. |
| `packages/agent/src/mastra/agent-runtime.ts` | Exposes `mcpDiscoverySkips` on `MastraAgentRuntime`. |
| `packages/agent/src/mastra/agent-streaming.ts` | Emits the chunks on fresh turns only. |
| `packages/assistant-contract/src/run-events.ts` | Declares the new kind. |
| `packages/assistant-ui/src/assistant-run-event-derivation.ts` | Adds the kind to `isAlwaysVisibleRunEvent`. |

---

### Task 1: Declare the run-event kind and make it always visible

This task is independently green and touches no agent code.

**Files:**
- Modify: `packages/assistant-contract/src/run-events.ts`
- Modify: `packages/assistant-ui/src/assistant-run-event-derivation.ts`
- Test: `packages/assistant-contract/src/__tests__/run-events.test.ts`
- Test: `packages/assistant-ui/src/__tests__/assistant-run-timeline.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: the string literal `'mcp.tools.unavailable'` as a member of `AssistantRunEventKind`; `isAlwaysVisibleRunEvent` returns `true` for it.

- [ ] **Step 1: Write the failing contract test**

Append to `packages/assistant-contract/src/__tests__/run-events.test.ts`, inside the existing `describe('ASSISTANT_RUN_EVENT_KINDS', ...)` block:

```ts
  it('declares the MCP discovery skip kind (BST-1602)', () => {
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('mcp.tools.unavailable');
  });

  it('keeps the MCP discovery skip kind OUT of the `.started` lifecycle namespace', () => {
    // It is a standalone breadcrumb: no tool ran and no phase began, so it
    // declares no terminal and must never be paired against one.
    expect(ASSISTANT_RUN_EVENT_KINDS.filter((kind) => kind.startsWith('mcp.'))).toEqual([
      'mcp.tools.unavailable',
    ]);
    expect('mcp.tools.unavailable'.endsWith('.started')).toBe(false);
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @brainstrike/assistant-contract vitest run -t "MCP discovery skip kind"
```

Expected: FAIL — `expect(received).toContain(expected)`, the kind is not declared.

- [ ] **Step 3: Declare the kind**

In `packages/assistant-contract/src/run-events.ts`, insert into `ASSISTANT_RUN_EVENT_KINDS` in alphabetical position — after `'memory.working.updated'` and before the `'pr.checks'` block:

```ts
  // One MCP server (or the whole client) contributed ZERO tools to this run
  // (BST-1602): discovery lost its timeout race, or that server's `listTools`
  // failed. The run still answers, with a materially reduced tool surface.
  //
  // Deliberately NOT `tool.failed`: no tool ran and none failed. The tool never
  // entered the map at all, so `search_tools` reports "0 results" and the
  // model's follow-up call fails fast — a `tool.failed` spelling would invent a
  // failed call in the Task Ledger and double-count the one the model does make.
  // Deliberately NOT `run.failed`: the turn is healthy and completes.
  //
  // Standalone breadcrumb, like the `worktree.*` kinds: it has no `.started`
  // counterpart and declares no terminal, so it never leaves a row spinning.
  // Status is `'failed'` rather than the `worktree.*` `'info'` — those record
  // operations that SUCCEEDED, this records a configured capability that did
  // not load.
  //
  // It is in `isAlwaysVisibleRunEvent`. That is load-bearing, not incidental:
  // run-event rows are hidden at default detail, so without the allowlist entry
  // this kind would reproduce the silent degradation it exists to report. It
  // passes the allowlist's own test — nothing else cards this fact. An ordinary
  // tool failure is excluded there because its ToolFallback card reports it;
  // a skipped server has no card, and the "Tool execution failed." card the
  // user does see belongs to the model's doomed follow-up call and names the
  // wrong cause. Carrying no `toolCallId`, it needs no exemption from the
  // card-suppression rule (unlike the two `tool.*` entries in that allowlist).
  'mcp.tools.unavailable',
```

- [ ] **Step 4: Run the contract test to verify it passes**

```bash
pnpm --filter @brainstrike/assistant-contract vitest run -t "MCP discovery skip"
```

Expected: PASS (both tests).

- [ ] **Step 5: Write the failing always-visible test**

In `packages/assistant-ui/src/__tests__/assistant-run-timeline.test.tsx`, inside `describe('isAlwaysVisibleRunEvent', ...)`, add:

```ts
  it('always surfaces a skipped MCP server (BST-1602)', () => {
    // Nothing else cards this: the tool never entered the map, so there is no
    // ToolFallback for it, and the run completes normally.
    expect(isAlwaysVisibleRunEvent(event('mcp.tools.unavailable', 'failed'))).toBe(true);
  });
```

- [ ] **Step 6: Run it to verify it fails**

```bash
pnpm --filter @brainstrike/assistant-ui vitest run -t "always surfaces a skipped MCP server"
```

Expected: FAIL — received `false`.

- [ ] **Step 7: Add the kind to the allowlist**

In `packages/assistant-ui/src/assistant-run-event-derivation.ts`, extend `isAlwaysVisibleRunEvent`'s return expression (keep the members alphabetically ordered by kind string):

```ts
  return (
    event.kind === 'mcp.tools.unavailable' ||
    event.kind === 'run.failed' ||
    event.kind === 'run.cancelled' ||
    event.kind === 'tool.approval.requested' ||
    event.kind === UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND
  );
```

Then append to that function's doc comment, before the closing `*/`:

```
 * `mcp.tools.unavailable` (BST-1602) is included for the same reason and is the
 * cleanest case in this list: an MCP server contributed zero tools to the run,
 * so there is NO card for it anywhere — the tool never entered the map. The
 * "Tool execution failed." card the user does see belongs to the model's
 * follow-up call on the missing tool and reports the wrong cause. It carries no
 * `toolCallId`, so like `run.failed`/`run.cancelled` it needs no exemption from
 * the card-suppression rule.
```

- [ ] **Step 8: Run the full assistant-ui and assistant-contract suites**

```bash
pnpm --filter @brainstrike/assistant-ui --filter @brainstrike/assistant-contract test
```

Expected: PASS. The pairing contract in `assistant-run-event-pairing-contract.test.ts` stays green with no edit — the new kind is not a `.started` kind, so `STARTED_KINDS` is unchanged, and it is never `'running'`, so it needs no `EXPLICIT_TERMINAL_KINDS` entry.

- [ ] **Step 9: Commit**

```bash
pnpm dlx ultracite fix
git add packages/assistant-contract packages/assistant-ui
git commit -m "feat(assistant): declare the mcp.tools.unavailable run event (BST-1602)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Loader reports skips as data and always logs at warn

**Files:**
- Create: `packages/agent/src/mastra/mcp-discovery-diagnostics.ts`
- Modify: `packages/agent/src/mastra/mcp-tool-loader.ts`
- Modify: `packages/agent/src/mastra/runtime-assembly/tool-pipeline.ts:481` (call-site compile fix only)
- Modify: `packages/agent/src/__tests__/mcp-tool-loader.spec.ts` (mechanical call-site update + new tests)
- Modify: `packages/agent/src/__tests__/mcp-host-adapter-core.spec.ts` (mechanical call-site update)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `type McpDiscoverySkipScope = 'client' | 'server'`
  - `interface McpDiscoverySkip { readonly reason: string; readonly scope: McpDiscoverySkipScope; readonly serverName?: string; readonly serverNames?: readonly string[]; readonly timeoutMs: number }`
  - `function boundMcpDiscoveryReason(value: unknown): string`
  - `const MAX_MCP_DISCOVERY_REASON_CHARS = 200`
  - `collectCombinedTools(...): Promise<CollectCombinedToolsResult>` where `interface CollectCombinedToolsResult { readonly mcpDiscoverySkips: readonly McpDiscoverySkip[]; readonly tools: ToolsInput }`

- [ ] **Step 1: Create the diagnostics module (type + reason bounder only)**

Create `packages/agent/src/mastra/mcp-discovery-diagnostics.ts`:

```ts
/**
 * MCP discovery diagnostics (BST-1602): the content-free facts a run records
 * when a configured MCP server contributed zero tools.
 *
 * Deliberately its own module rather than living in `mcp-tool-loader.ts` or
 * `stream-run-event-chunks.ts`. The loader must not decide presentation (the
 * coupling that produced the original silent degradation: a substring heuristic
 * demoted the two likeliest failures to `debug`), and `stream-run-event-chunks`
 * is documented as the leaf every other streaming concern depends on — giving
 * it an import of the MCP loader would invert that.
 */

/**
 * `'client'` — discovery itself failed (rejected, or lost the timeout race), so
 * EVERY configured server contributed nothing. One lost race is ONE fact, so a
 * client-scope skip names every affected server in `serverNames` rather than
 * being fanned out into one skip per server, which would invent N failures.
 *
 * `'server'` — exactly that one server's `listTools` failed.
 */
export type McpDiscoverySkipScope = 'client' | 'server';

export interface McpDiscoverySkip {
  readonly reason: string;
  readonly scope: McpDiscoverySkipScope;
  /** Present iff `scope === 'server'`. */
  readonly serverName?: string;
  /** Present iff `scope === 'client'`; every configured server name. */
  readonly serverNames?: readonly string[];
  readonly timeoutMs: number;
}

export const MAX_MCP_DISCOVERY_REASON_CHARS = 200;

/**
 * Bound the reason before it becomes run-event metadata.
 * `sanitizeAssistantRunEventMetadata` redacts by KEY, not by value, and an HTTP
 * transport error can carry a URL, so an unbounded provider string would go
 * durable verbatim.
 */
export function boundMcpDiscoveryReason(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw.length <= MAX_MCP_DISCOVERY_REASON_CHARS
    ? raw
    : `${raw.slice(0, MAX_MCP_DISCOVERY_REASON_CHARS)}…`;
}
```

- [ ] **Step 2: Write the failing loader tests**

Append a new `describe` block to `packages/agent/src/__tests__/mcp-tool-loader.spec.ts`, inside the outer `describe('mcp-tool-loader', ...)`. Note the existing file already imports `addLogListener`, `LogLevel`, and `LogRecord`.

```ts
  describe('discovery skip reporting (BST-1602)', () => {
    const stdioServer = (name: string) =>
      ({ command: 'echo', name, transport: 'stdio' as const });

    it('reports a client-scope skip and logs at warn when discovery rejects', async () => {
      const logRecords: LogRecord[] = [];
      const removeLogListener = addLogListener((record) => logRecords.push(record));
      const mockMcpClient = {
        listTools: vi.fn(),
        // "Connection closed" is one of the two reasons the deleted
        // pickMcpDiscoveryLogMethod demoted to debug.
        listToolsetsWithErrors: vi.fn().mockRejectedValue(new Error('Connection closed')),
      };

      try {
        const result = await collectCombinedTools({
          mcpClient: mockMcpClient as unknown as McpRuntimeClient,
          mcpConfig: { servers: [stdioServer('alpha'), stdioServer('beta')] },
          sanitizedLocalTools: undefined,
          scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
          timeoutOverrideMs: undefined,
          toolNameMap: new Map(),
        });

        // ONE skip for one lost race, naming both servers — not two skips.
        expect(result.mcpDiscoverySkips).toEqual([
          {
            reason: 'Connection closed',
            scope: 'client',
            serverNames: ['alpha', 'beta'],
            timeoutMs: 5000,
          },
        ]);
        expect(logRecords).toContainEqual(
          expect.objectContaining({
            level: 'warn',
            message: 'MCP tool discovery skipped',
            scope: 'MastraAgentMcpTools',
          })
        );
      } finally {
        removeLogListener();
      }
    });

    it('reports a client-scope skip and logs at warn when discovery times out', async () => {
      vi.useFakeTimers();
      const logRecords: LogRecord[] = [];
      const removeLogListener = addLogListener((record) => logRecords.push(record));
      const mockMcpClient = {
        listTools: vi.fn(),
        listToolsetsWithErrors: vi.fn().mockReturnValue(new Promise(() => undefined)),
      };

      try {
        const resultPromise = collectCombinedTools({
          mcpClient: mockMcpClient as unknown as McpRuntimeClient,
          mcpConfig: { servers: [stdioServer('alpha')] },
          sanitizedLocalTools: undefined,
          scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
          timeoutOverrideMs: undefined,
          toolNameMap: new Map(),
        });
        await vi.advanceTimersByTimeAsync(5000);
        const result = await resultPromise;

        expect(result.mcpDiscoverySkips).toEqual([
          {
            reason: 'mcp_tool_discovery_timeout: timeout_5000',
            scope: 'client',
            serverNames: ['alpha'],
            timeoutMs: 5000,
          },
        ]);
        // The second reason the deleted heuristic demoted to debug.
        expect(logRecords).toContainEqual(
          expect.objectContaining({ level: 'warn', message: 'MCP tool discovery skipped' })
        );
      } finally {
        removeLogListener();
      }
    });

    it('reports one server-scope skip per failing server and logs each at warn', async () => {
      const logRecords: LogRecord[] = [];
      const removeLogListener = addLogListener((record) => logRecords.push(record));
      const mockMcpClient = createMockMcpClient(
        { alpha: { search: { description: 'search', id: 'search' } } },
        { beta: 'Connection closed' }
      );

      try {
        const result = await collectCombinedTools({
          mcpClient: mockMcpClient as unknown as McpRuntimeClient,
          mcpConfig: { servers: [stdioServer('alpha'), stdioServer('beta')] },
          sanitizedLocalTools: undefined,
          scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
          timeoutOverrideMs: undefined,
          toolNameMap: new Map(),
        });

        expect(result.tools).toHaveProperty('alpha_search');
        expect(result.mcpDiscoverySkips).toEqual([
          { reason: 'Connection closed', scope: 'server', serverName: 'beta', timeoutMs: 5000 },
        ]);
        expect(logRecords).toContainEqual(
          expect.objectContaining({
            level: 'warn',
            message: 'MCP server tool discovery skipped',
          })
        );
      } finally {
        removeLogListener();
      }
    });

    it('reports no skips when discovery is healthy', async () => {
      const mockMcpClient = createMockMcpClient({
        alpha: { search: { description: 'search', id: 'search' } },
      });

      const result = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: { servers: [stdioServer('alpha')] },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result.mcpDiscoverySkips).toEqual([]);
    });

    it('bounds a long reason before it becomes durable metadata', async () => {
      const mockMcpClient = {
        listTools: vi.fn(),
        listToolsetsWithErrors: vi.fn().mockRejectedValue(new Error('x'.repeat(500))),
      };

      const result = await collectCombinedTools({
        mcpClient: mockMcpClient as unknown as McpRuntimeClient,
        mcpConfig: { servers: [stdioServer('alpha')] },
        sanitizedLocalTools: undefined,
        scaledDefaultTokens: MAX_TOOL_RESULT_TOKENS,
        timeoutOverrideMs: undefined,
        toolNameMap: new Map(),
      });

      expect(result.mcpDiscoverySkips[0]?.reason).toBe(`${'x'.repeat(200)}…`);
    });
  });
```

- [ ] **Step 3: Run them to verify they fail**

```bash
pnpm --filter @brainstrike/agent vitest run mcp-tool-loader -t "discovery skip reporting"
```

Expected: FAIL — `result.mcpDiscoverySkips` is `undefined` (the function still returns a bare `ToolsInput`).

- [ ] **Step 4: Rewrite the loader's discovery reporting**

In `packages/agent/src/mastra/mcp-tool-loader.ts`:

Add to the imports:

```ts
import {
  boundMcpDiscoveryReason,
  type McpDiscoverySkip,
} from './mcp-discovery-diagnostics';
```

Add the result type next to `CollectCombinedToolsOptions`:

```ts
export interface CollectCombinedToolsResult {
  /** Empty when every configured server contributed its tools. */
  readonly mcpDiscoverySkips: readonly McpDiscoverySkip[];
  readonly tools: ToolsInput;
}

type McpDiscoveryOutcome =
  | { readonly kind: 'discovered'; readonly value: McpToolsetsWithErrors }
  | { readonly kind: 'skipped'; readonly skip: McpDiscoverySkip };
```

Change the signature and the three early returns of `collectCombinedTools`:

```ts
}: CollectCombinedToolsOptions): Promise<CollectCombinedToolsResult> {
  const combined: ToolsInput = sanitizedLocalTools ? { ...sanitizedLocalTools } : {};

  if (!mcpClient) {
    return { mcpDiscoverySkips: [], tools: combined };
  }

  const serverList = mcpConfig ? mcpConfig.servers : mcpClient.configuredServers;
  const namedServers = serverList.filter((server) => server?.name);
  if (namedServers.length === 0) {
    return { mcpDiscoverySkips: [], tools: combined };
  }

  const timeoutMs = resolveMcpTimeoutMs(timeoutOverrideMs);
  const outcome = await fetchMcpToolsetsWithTimeout(
    mcpClient,
    timeoutMs,
    namedServers.map((server) => server.name)
  );
  if (outcome.kind === 'skipped') {
    return { mcpDiscoverySkips: [outcome.skip], tools: combined };
  }
  const discovered = outcome.value;
  const mcpDiscoverySkips = collectMcpToolsetErrors(discovered.errors, timeoutMs);
```

Change the function's final `return combined;` to:

```ts
  return { mcpDiscoverySkips, tools: combined };
```

Replace `fetchMcpToolsetsWithTimeout`, `logMcpToolsetErrors`, `logMcpDiscoverySkip`, and `pickMcpDiscoveryLogMethod` entirely with:

```ts
async function fetchMcpToolsetsWithTimeout(
  mcpClient: McpRuntimeClient,
  timeoutMs: number,
  serverNames: readonly string[]
): Promise<McpDiscoveryOutcome> {
  try {
    const value = await Promise.race([
      mcpClient.listToolsetsWithErrors(),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              createMastraAgentError('mcp_tool_discovery_timeout', {
                detail: `timeout_${timeoutMs}`,
              })
            ),
          timeoutMs
        );
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    return { kind: 'discovered', value };
  } catch (err) {
    const reason = boundMcpDiscoveryReason(err);
    // WARN, unconditionally. The deleted `pickMcpDiscoveryLogMethod` demoted
    // exactly the two likeliest reasons here ("Connection closed" and
    // `mcp_tool_discovery_timeout`) to `debug`, so at LOG_LEVEL=info a run that
    // lost EVERY MCP tool left no record at all (BST-1602).
    logger.warn('MCP tool discovery skipped', {
      code: 'mcp_tools_unavailable',
      reason,
      serverNames,
      timeoutMs,
    });
    return {
      kind: 'skipped',
      skip: { reason, scope: 'client', serverNames: [...serverNames], timeoutMs },
    };
  }
}

function collectMcpToolsetErrors(
  errors: Record<string, string>,
  timeoutMs: number
): readonly McpDiscoverySkip[] {
  return Object.entries(errors).map(([serverName, rawReason]) => {
    const reason = boundMcpDiscoveryReason(rawReason);
    logger.warn('MCP server tool discovery skipped', {
      code: 'mcp_server_tools_unavailable',
      reason,
      serverName,
      timeoutMs,
    });
    return { reason, scope: 'server' as const, serverName, timeoutMs };
  });
}
```

- [ ] **Step 5: Update the existing call sites mechanically**

The loader's existing spec is 1487 lines with ~45 call sites; two more live in `mcp-host-adapter-core.spec.ts`. They bind the returned value directly, so destructure at the binding:

```bash
cd packages/agent
sed -i '' 's/const result = await collectCombinedTools({/const { tools: result } = await collectCombinedTools({/' src/__tests__/mcp-tool-loader.spec.ts
sed -i '' 's/const tools = await collectCombinedTools({/const { tools } = await collectCombinedTools({/' src/__tests__/mcp-host-adapter-core.spec.ts
```

Then fix by hand the two sites `sed` cannot express:
- `src/__tests__/mcp-tool-loader.spec.ts:966` binds `const resultPromise = collectCombinedTools({` and awaits it later — change the later `const result = await resultPromise;` to `const { tools: result } = await resultPromise;`.
- The new `describe('discovery skip reporting (BST-1602)')` block from Step 2 uses `result.tools` / `result.mcpDiscoverySkips` deliberately — the `sed` must not have rewritten it. Verify with `rg -n "const \{ tools: result \}" src/__tests__/mcp-tool-loader.spec.ts | wc -l` and confirm the new block's four `const result = await collectCombinedTools({` occurrences were rewritten; if so, revert those four to the un-destructured form.

In `packages/agent/src/mastra/runtime-assembly/tool-pipeline.ts:481`, change:

```ts
  const combinedTools = await collectCombinedTools({
```

to:

```ts
  const { mcpDiscoverySkips, tools: combinedTools } = await collectCombinedTools({
```

`mcpDiscoverySkips` is unused until Task 3; add `void mcpDiscoverySkips;` immediately after the call **only if** lint fails on an unused binding, and delete that line in Task 3.

- [ ] **Step 6: Run the loader suite and typecheck**

```bash
pnpm --filter @brainstrike/agent typecheck && pnpm --filter @brainstrike/agent vitest run mcp-tool-loader mcp-host-adapter-core
```

Expected: PASS, including the five new tests.

- [ ] **Step 7: Commit**

```bash
pnpm dlx ultracite fix
git add packages/agent
git commit -m "fix(mcp): report discovery skips as data and log them at warn (BST-1602)

pickMcpDiscoveryLogMethod demoted the two likeliest discovery failures to
debug, so at LOG_LEVEL=info a run that lost every MCP tool left no record.
Delete the heuristic and return structured skips instead of deciding
presentation inside the loader.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Thread the skips onto the runtime

**Files:**
- Modify: `packages/agent/src/mastra/runtime-assembly/tool-pipeline.ts` (`RuntimeToolMapResult`, the return object)
- Modify: `packages/agent/src/mastra/agent-runtime.ts` (`MastraAgentRuntime`, the `composeRuntimeToolMap` destructure, the returned runtime object)

**Interfaces:**
- Consumes: `McpDiscoverySkip` and `CollectCombinedToolsResult` from Task 2.
- Produces: `MastraAgentRuntime.mcpDiscoverySkips: readonly McpDiscoverySkip[]` — always present, `[]` when discovery was healthy or no MCP client existed.

- [ ] **Step 1: Write the failing runtime test**

Create `packages/agent/src/mastra/__tests__/mcp-discovery-runtime-diagnostics.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { MastraAgentRuntime } from '../agent-runtime';
import type { McpDiscoverySkip } from '../mcp-discovery-diagnostics';

describe('MastraAgentRuntime.mcpDiscoverySkips', () => {
  it('is a required, content-free field on the runtime contract', () => {
    // A type-level guard: the field must exist and be non-optional, so a run
    // can never reach the streaming layer with the skips silently dropped.
    const skip: McpDiscoverySkip = {
      reason: 'Connection closed',
      scope: 'client',
      serverNames: ['alpha'],
      timeoutMs: 5000,
    };
    const skips: MastraAgentRuntime['mcpDiscoverySkips'] = [skip];
    expect(skips).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @brainstrike/agent typecheck
```

Expected: FAIL — `Property 'mcpDiscoverySkips' does not exist on type 'MastraAgentRuntime'`.

- [ ] **Step 3: Add the field to `RuntimeToolMapResult`**

In `packages/agent/src/mastra/runtime-assembly/tool-pipeline.ts`, add the import:

```ts
import type { McpDiscoverySkip } from '../mcp-discovery-diagnostics';
```

Add to `RuntimeToolMapResult`, alphabetically after `mcpClient`:

```ts
  /** Content-free record of every MCP server that contributed nothing (BST-1602). */
  mcpDiscoverySkips: readonly McpDiscoverySkip[];
```

Delete the `void mcpDiscoverySkips;` line if Step 5 of Task 2 added it, and add `mcpDiscoverySkips,` to this function's returned object in alphabetical position.

- [ ] **Step 4: Add the field to `MastraAgentRuntime`**

In `packages/agent/src/mastra/agent-runtime.ts`, add the import:

```ts
import type { McpDiscoverySkip } from './mcp-discovery-diagnostics';
```

Add to the `MastraAgentRuntime` interface, alphabetically after `mcpClient?: McpRuntimeClient;`:

```ts
  /**
   * Every MCP server that contributed ZERO tools to this run (BST-1602). Empty
   * when discovery was healthy or no MCP client existed. Consumed by the fresh
   * turn's stream prelude, which mints one `mcp.tools.unavailable` run event per
   * entry. Content-free, like `tokenDiagnostics` and `toolDiscovery`.
   */
  mcpDiscoverySkips: readonly McpDiscoverySkip[];
```

Add `mcpDiscoverySkips,` to the `composeRuntimeToolMap` destructure (alphabetically after `mcpClient,`) and to the returned runtime object (alphabetically after `mcpAppToolAdmission,`).

- [ ] **Step 5: Run typecheck and the agent suite**

```bash
pnpm --filter @brainstrike/agent typecheck && pnpm --filter @brainstrike/agent test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm dlx ultracite fix
git add packages/agent
git commit -m "feat(mcp): carry discovery skips on the agent runtime (BST-1602)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Emit the run events on fresh turns only

**Files:**
- Modify: `packages/agent/src/mastra/mcp-discovery-diagnostics.ts` (add the chunk minting)
- Modify: `packages/agent/src/mastra/agent-streaming.ts:2623` (`createStreamIteratorFromRuntime`)
- Test: `packages/agent/src/mastra/__tests__/mcp-discovery-run-events.spec.ts`

**Interfaces:**
- Consumes: `MastraAgentRuntime.mcpDiscoverySkips` from Task 3; `'mcp.tools.unavailable'` from Task 1.
- Produces: `function makeMcpDiscoverySkipChunks(skips: readonly McpDiscoverySkip[]): StreamChunk[]`.

**Why `createStreamIteratorFromRuntime` is the right seam:** it is the documented "initial turn" entry point, reached only from `streamMastraAgent`. The approval-resume and suspend-resume legs call `runTurnAttempts` directly, so they inherit nothing — which is exactly the "fresh turns only" rule. Prepending also preserves the documented invariant that a construction failure rejects the returned promise rather than throwing mid-stream: `firstAttempt` is still awaited before the generator is built.

**Why the chunks precede `run.started`:** discovery genuinely happens during runtime construction, before generation. The run row is created by `repository.createThreadRun` independently of the `run.started` event, so a preceding row has a `run_id` to attach to, and no consumer assumes `run.started` is first (`readEditActivityRunEvent` and `resolveStatus` both filter rather than index).

- [ ] **Step 1: Write the failing chunk test**

Create `packages/agent/src/mastra/__tests__/mcp-discovery-run-events.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  makeMcpDiscoverySkipChunks,
  type McpDiscoverySkip,
} from '../mcp-discovery-diagnostics';

describe('makeMcpDiscoverySkipChunks', () => {
  it('mints nothing when discovery was healthy', () => {
    expect(makeMcpDiscoverySkipChunks([])).toEqual([]);
  });

  it('mints ONE failed row for a client-wide skip, naming every server', () => {
    const skip: McpDiscoverySkip = {
      reason: 'Connection closed',
      scope: 'client',
      serverNames: ['alpha', 'beta'],
      timeoutMs: 5000,
    };

    const chunks = makeMcpDiscoverySkipChunks([skip]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      event: {
        detail: 'alpha, beta skipped for this request — Connection closed',
        kind: 'mcp.tools.unavailable',
        label: 'MCP tools unavailable',
        metadata: {
          reason: 'Connection closed',
          scope: 'client',
          serverNames: ['alpha', 'beta'],
          timeoutMs: 5000,
        },
        status: 'failed',
      },
      type: 'run-event',
    });
  });

  it('mints one row per server-scope skip', () => {
    const chunks = makeMcpDiscoverySkipChunks([
      { reason: 'boom', scope: 'server', serverName: 'alpha', timeoutMs: 5000 },
      { reason: 'bang', scope: 'server', serverName: 'beta', timeoutMs: 5000 },
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      event: {
        detail: 'alpha skipped for this request — boom',
        kind: 'mcp.tools.unavailable',
        label: 'MCP server tools unavailable',
        status: 'failed',
      },
    });
    expect(chunks[1]).toMatchObject({
      event: { detail: 'beta skipped for this request — bang' },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @brainstrike/agent vitest run mcp-discovery-run-events
```

Expected: FAIL — `makeMcpDiscoverySkipChunks is not a function`.

- [ ] **Step 3: Add the chunk minting**

Append to `packages/agent/src/mastra/mcp-discovery-diagnostics.ts`:

```ts
import type { StreamChunk } from '../types';
import { makeRunDetailEventChunk } from './stream-run-event-chunks';

const MCP_DISCOVERY_SKIP_RUN_EVENT_KIND = 'mcp.tools.unavailable' as const;

/**
 * One row per ACTUAL failure. A client-scope skip is one lost race and mints
 * ONE row naming every affected server; fanning it out per server would report
 * N failures where one happened.
 */
export function makeMcpDiscoverySkipChunks(
  skips: readonly McpDiscoverySkip[]
): StreamChunk[] {
  return skips.map((skip) => {
    const names = skip.scope === 'client' ? (skip.serverNames ?? []).join(', ') : skip.serverName;
    return makeRunDetailEventChunk(
      MCP_DISCOVERY_SKIP_RUN_EVENT_KIND,
      'failed',
      skip.scope === 'client' ? 'MCP tools unavailable' : 'MCP server tools unavailable',
      `${names} skipped for this request — ${skip.reason}`,
      {
        reason: skip.reason,
        scope: skip.scope,
        timeoutMs: skip.timeoutMs,
        ...(skip.serverName === undefined ? {} : { serverName: skip.serverName }),
        ...(skip.serverNames === undefined ? {} : { serverNames: [...skip.serverNames] }),
      }
    );
  });
}
```

- [ ] **Step 4: Run the chunk test to verify it passes**

```bash
pnpm --filter @brainstrike/agent vitest run mcp-discovery-run-events
```

Expected: PASS (all three).

- [ ] **Step 5: Write the failing fresh-turn-only test**

Append to `packages/agent/src/mastra/__tests__/mcp-discovery-run-events.spec.ts`:

```ts
describe('fresh-turn prelude', () => {
  it('prepends the skip chunks ahead of the turn stream', async () => {
    const { prependMcpDiscoverySkipChunks } = await import('../mcp-discovery-diagnostics');
    async function* turn() {
      yield { finishReason: 'stop', path: [], type: 'message-finish' } as never;
    }

    const chunks = [];
    for await (const chunk of prependMcpDiscoverySkipChunks(
      [{ reason: 'boom', scope: 'server', serverName: 'alpha', timeoutMs: 5000 }],
      turn()
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ type: 'run-event' });
    expect(chunks[1]).toMatchObject({ type: 'message-finish' });
  });

  it('passes the turn stream through untouched when there are no skips', async () => {
    const { prependMcpDiscoverySkipChunks } = await import('../mcp-discovery-diagnostics');
    async function* turn() {
      yield { finishReason: 'stop', path: [], type: 'message-finish' } as never;
    }

    const chunks = [];
    for await (const chunk of prependMcpDiscoverySkipChunks([], turn())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'message-finish' });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
pnpm --filter @brainstrike/agent vitest run mcp-discovery-run-events -t "fresh-turn prelude"
```

Expected: FAIL — `prependMcpDiscoverySkipChunks is not a function`.

- [ ] **Step 7: Add the prelude generator**

Append to `packages/agent/src/mastra/mcp-discovery-diagnostics.ts`:

```ts
/**
 * Yield the skip rows, then the turn. Called ONLY from the initial-turn seam
 * (`createStreamIteratorFromRuntime`), so the approval- and suspend-resume legs
 * — which route through `runTurnAttempts` directly — stay quiet. A resume
 * rebuilds the runtime and re-runs discovery, so without that scoping the same
 * rows would be re-emitted on every approval (the hazard
 * `withoutDuplicateRunStarted` exists for).
 */
export async function* prependMcpDiscoverySkipChunks(
  skips: readonly McpDiscoverySkip[],
  turn: AsyncIterableIterator<StreamChunk>
): AsyncIterableIterator<StreamChunk> {
  for (const chunk of makeMcpDiscoverySkipChunks(skips)) {
    yield chunk;
  }
  yield* turn;
}
```

- [ ] **Step 8: Wire it into the initial turn**

In `packages/agent/src/mastra/agent-streaming.ts`, add the import:

```ts
import { prependMcpDiscoverySkipChunks } from './mcp-discovery-diagnostics';
```

Replace the body of `createStreamIteratorFromRuntime` (at line ~2623):

```ts
async function createStreamIteratorFromRuntime(
  params: StreamIterationParams
): Promise<StreamIterator> {
  const { runtime, runtimeData } = params;
  // `firstAttempt` is still awaited HERE, before the generator is built, so a
  // construction failure rejects the promise `streamMastraAgent` returns rather
  // than throwing mid-stream (see runTurnAttempts' `firstAttempt` contract).
  const attempts = runTurnAttempts({
    firstAttempt: await createInitialTurnAttempt(params, undefined),
    makeContinuation: (input) =>
      createInitialTurnAttempt(
        params,
        input.continuationMessages,
        input.carriedLifecycleState,
        false
      ),
    maxAttempts: runtime.resilienceConfig.streamStallAttempts,
    runtime,
    runtimeData,
  });
  // The skip rows precede `run.started` because discovery genuinely happened
  // first, during runtime construction. The thread-run row is created by
  // `repository.createThreadRun`, not by `run.started`, so they have a run to
  // attach to.
  return prependMcpDiscoverySkipChunks(runtime.mcpDiscoverySkips, attempts);
}
```

- [ ] **Step 9: Run the agent suite and typecheck**

```bash
pnpm --filter @brainstrike/agent typecheck && pnpm --filter @brainstrike/agent test
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
pnpm dlx ultracite fix
git add packages/agent
git commit -m "feat(mcp): surface a skipped MCP server in the run timeline (BST-1602)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Document the contract

**Files:**
- Modify: `docs/agents/assistant-providers.md`
- Modify: `docs/agents/assistant-persistence.md`

- [ ] **Step 1: Add the providers subsection**

Append a new `### MCP discovery skip reporting (BST-1602)` subsection to `docs/agents/assistant-providers.md`, placed immediately before `### Tool discovery contract (LIVE for hosted Mastra catalog search)` (line ~4102). Content must state:

- `collectCombinedTools` returns `{ mcpDiscoverySkips, tools }`; a skip is data, never a presentation decision made inside the loader.
- Every skip logs at `warn`. There is NO reason-string heuristic — `pickMcpDiscoveryLogMethod` was deleted because demoting "Connection closed" and `mcp_tool_discovery_timeout` to `debug` left a run that lost every MCP tool with no record at `LOG_LEVEL=info`.
- Client scope is ONE skip naming every configured server; server scope is one skip per failing server.
- `reason` is bounded to `MAX_MCP_DISCOVERY_REASON_CHARS` (200) because run-event metadata sanitization is key-based, not value-based.
- The rows are emitted only from the initial-turn seam; resume legs rebuild the runtime and would otherwise duplicate them.
- The 5s `DEFAULT_MCP_TIMEOUT_MS` is unchanged, and no production caller supplies `mcpTimeoutMs` — the only two call sites (an e2e helper and a spec) pass `undefined`, so 5s is always the effective value. Recorded as open, not fixed.

- [ ] **Step 2: Add the persistence subsection**

Append a `### MCP DISCOVERY SKIP KIND (BST-1602)` subsection to `docs/agents/assistant-persistence.md`, immediately after the `### WORKTREE LIFECYCLE KINDS (BST-1390)` section (line ~984). Content must state:

- `mcp.tools.unavailable` is an additive `ASSISTANT_RUN_EVENT_KINDS` member emitted by the agent stream (not a main-process writer), status `'failed'`, declaring no terminal.
- It is in `isAlwaysVisibleRunEvent` — required, because run-event rows are otherwise hidden at default detail and the kind exists specifically to end a silent degradation.
- `AssistantRunTimeline` needs no change: `classifyRunEvent` falls through to `'lifecycle'` for any kind that is not `memory.*`/`tool.*`.
- A kind missing from `ASSISTANT_RUN_EVENT_KINDS` is rejected by `readAssistantRunEvent` and the row disappears, which is why the contract entry comes first.

- [ ] **Step 3: Verify the whole-repo gate**

```bash
pnpm run typecheck && pnpm run lint && pnpm run test
```

Expected: all green in the same run.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs(agent): pin the MCP discovery skip reporting contract (BST-1602)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** loader/presentation split → Task 2; run-event kind and always-visible → Task 1; one row per actual failure → Tasks 2 and 4; reason bounding at 200 → Tasks 2 and 4; fresh turns only → Task 4; both docs → Task 5; the five spec test items map to Tasks 1, 2 and 4.
- **Correction to the spec's "no tests" premise:** `packages/agent/src/__tests__/mcp-tool-loader.spec.ts` already exists at 1487 lines with ~45 `collectCombinedTools` call sites, plus 2 in `mcp-host-adapter-core.spec.ts`. "No tests" is true only of the skip/log-level paths. Step 5 of Task 2 handles the mechanical churn.
- **Type consistency:** `McpDiscoverySkip`, `mcpDiscoverySkips`, `boundMcpDiscoveryReason`, `makeMcpDiscoverySkipChunks`, and `prependMcpDiscoverySkipChunks` are spelled identically in every task that references them.
