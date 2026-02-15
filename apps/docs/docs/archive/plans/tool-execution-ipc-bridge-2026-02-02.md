---
title: "Tool Execution IPC Bridge 2026 02 02"
---

# Tool Execution IPC Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable the Tool Playground to execute native and MCP tools through an IPC bridge from renderer to main process.

**Architecture:** Add `window.tools.execute` API via preload, create `ipc-tools.ts` handler in main process that routes to either native tool implementations (reusing `assistant-server/` logic) or MCP `callTool()`. Native tools need a standalone executor that doesn't require full Mastra runtime.

**Tech Stack:** Electron IPC (ipcMain/ipcRenderer), TypeScript, Vitest for testing

---

## Task 1: Add Types and Preload API

**Files:**
- Modify: `apps/desktop/src/types/electron.d.ts`
- Modify: `apps/desktop/src/preload.ts`

**Step 1: Add type definitions for tools API**

Add to `apps/desktop/src/types/electron.d.ts` inside the `Window` interface:

```typescript
tools: {
  execute: (
    toolId: string,
    input: unknown
  ) => Promise<{
    success: boolean;
    result?: unknown;
    error?: string;
    durationMs: number;
  }>;
};
```

**Step 2: Add preload bridge**

Add to `apps/desktop/src/preload.ts` after the `mcp` section:

```typescript
// Tool execution API (for playground testing)
contextBridge.exposeInMainWorld('tools', {
  execute: (toolId: string, input: unknown) =>
    ipcRenderer.invoke('tools:execute', toolId, input),
});
```

**Step 3: Verify types compile**

Run: `pnpm type-check --filter @brainstrike/desktop`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/desktop/src/types/electron.d.ts apps/desktop/src/preload.ts
git commit -m "feat(desktop): add tools.execute preload API types"
```

---

## Task 2: Create Native Tool Executor

**Files:**
- Create: `apps/desktop/src/native-tool-executor.ts`
- Create: `apps/desktop/src/__tests__/main/native-tool-executor.test.ts`

**Step 1: Write the test file**

Create `apps/desktop/src/__tests__/main/native-tool-executor.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the module
vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../secrets', () => ({
  getSecretsService: vi.fn(() => ({
    getKey: vi.fn().mockResolvedValue(null),
  })),
}));

import { executeNativeTool, isExecutableNativeTool } from '../../native-tool-executor';

describe('native-tool-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isExecutableNativeTool', () => {
    it('returns true for web.searchDocs', () => {
      expect(isExecutableNativeTool('web.searchDocs')).toBe(true);
    });

    it('returns true for web.docSummary', () => {
      expect(isExecutableNativeTool('web.docSummary')).toBe(true);
    });

    it('returns false for unknown tools', () => {
      expect(isExecutableNativeTool('unknown.tool')).toBe(false);
    });

    it('returns false for MCP tools', () => {
      expect(isExecutableNativeTool('mcp__server__tool')).toBe(false);
    });
  });

  describe('executeNativeTool', () => {
    it('executes web.searchDocs successfully', async () => {
      const result = await executeNativeTool('web.searchDocs', {
        query: 'assistant',
        limit: 5,
      });

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('executes web.docSummary successfully', async () => {
      const result = await executeNativeTool('web.docSummary', {
        docId: 'assistant-ui-integration',
      });

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
    });

    it('returns error for unknown tool', async () => {
      const result = await executeNativeTool('unknown.tool', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });

    it('returns error for invalid input', async () => {
      const result = await executeNativeTool('web.searchDocs', {
        query: '', // Invalid: too short
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/desktop -- native-tool-executor`
Expected: FAIL with "Cannot find module"

**Step 3: Create the executor implementation**

Create `apps/desktop/src/native-tool-executor.ts`:

```typescript
/**
 * Native Tool Executor
 *
 * Executes native BrainStrike tools for the Tool Playground.
 * Currently supports web tools (searchDocs, docSummary).
 * Database-dependent tools (retrieval, hybridSearch) require additional setup.
 */

import { createLogger } from '@brainstrike/utils';
import { z } from 'zod';

const logger = createLogger('NativeToolExecutor');

/**
 * Result of executing a tool.
 */
export interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * Set of native tools that can be executed in the playground.
 * Not all native tools are executable - some require runtime context.
 */
const EXECUTABLE_NATIVE_TOOLS = new Set([
  'web.searchDocs',
  'web.docSummary',
]);

/**
 * Check if a tool ID is an executable native tool.
 */
export function isExecutableNativeTool(toolId: string): boolean {
  return EXECUTABLE_NATIVE_TOOLS.has(toolId);
}

// ============================================================================
// Web Tools Implementation (copied from @brainstrike/agent/src/mastra/web-tools.ts)
// These are self-contained and don't require database access.
// ============================================================================

interface WebDocEntry {
  id: string;
  title: string;
  summary: string;
  url: string;
  tags: readonly string[];
  sections: readonly string[];
  versionIntroduced?: string;
}

type IndexedDoc = WebDocEntry & {
  tokens: Set<string>;
  titleTokens: Set<string>;
  sentenceTokens: Array<{ text: string; tokens: Set<string> }>;
};

const DOCS_INDEX: readonly WebDocEntry[] = [
  {
    id: 'assistant-ui-integration',
    title: 'Assistant UI Integration Guide',
    summary:
      'Embed the Assistant-UI panel into the Brainstrike IDE right panel and wire transports for both web and desktop.',
    url: '/docs/assistant/assistant-ui-integration',
    tags: ['assistant-ui', 'web', 'desktop'],
    sections: [
      'Enable Assistant-UI globally unless the APP_SHELL_ASSISTANT_UI flag is explicitly disabled.',
      'AssistantUiPanel expects streaming responses that follow the AI SDK v5 format with tool events.',
      'Desktop runtime exposes a preload bridge for local assistant transport discovery.',
    ],
    versionIntroduced: '2025.09',
  },
  {
    id: 'web-tool-dispatcher',
    title: 'Web Tool Dispatcher Patterns',
    summary:
      'Outline for building safe read-only tool dispatchers on the web tier, including schema validation and streaming progress.',
    url: '/docs/assistant/web-tool-dispatcher',
    tags: ['web', 'tools', 'progress'],
    sections: [
      'Validate inputs using shared zod schemas from @brainstrike/agent before invoking tool logic.',
      'Implement deterministic progress updates to keep Assistant-UI responsive during server work.',
      'Limit output payload size and strip secrets when proxying to external services.',
    ],
    versionIntroduced: '2025.09',
  },
  {
    id: 'desktop-safe-storage',
    title: 'Desktop Safe Storage & Secrets',
    summary:
      'Describes how provider API keys are encrypted via Electron safeStorage and surfaced to the renderer through IPC.',
    url: '/docs/desktop/safe-storage',
    tags: ['desktop', 'security', 'safeStorage'],
    sections: [
      'Keys are encrypted before writing to disk and decrypted lazily on demand by the assistant server.',
      'Preload exposes a narrow context bridge with explicit allow-listing for secrets APIs.',
      'Unit and E2E coverage ensure keys survive restart and remain unreadable in plaintext.',
    ],
    versionIntroduced: '2025.08',
  },
  {
    id: 'mcp-hot-reload',
    title: 'MCP Hot Reload Lifecycle',
    summary:
      'Documents the filesystem watcher that reloads Model Context Protocol servers when mcp.config.json changes.',
    url: '/docs/assistant/mcp-hot-reload',
    tags: ['desktop', 'mcp', 'tools'],
    sections: [
      'Watchers debounce file writes and rebuild MCP clients with decrypted credentials.',
      'Progress events bubble to Assistant-UI to reflect tool initialization steps.',
      'Errors in config parsing surface as inline tool errors without crashing the agent runtime.',
    ],
    versionIntroduced: '2025.09',
  },
  {
    id: 'guardrails-and-telemetry',
    title: 'Guardrails & Telemetry Checklist',
    summary:
      'Checklist for validating tool input/output schemas, enforcing rate limits, and capturing assistant telemetry.',
    url: '/docs/assistant/guardrails',
    tags: ['guardrails', 'telemetry', 'quality'],
    sections: [
      'Wrap tool dispatches with structured logging for latency and token usage.',
      'Emit progress updates for long-running operations to keep the UI from appearing stalled.',
      'Document fallback behaviors and error handling strategy before shipping to production.',
    ],
    versionIntroduced: '2025.09',
  },
];

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function splitIntoSentences(value: string): string[] {
  const matches = value.match(/[^.!?]+[.!?]?/g);
  if (!matches) {
    return [value];
  }
  return matches.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

function indexDocs(entries: readonly WebDocEntry[]): {
  docs: readonly IndexedDoc[];
  map: ReadonlyMap<string, IndexedDoc>;
} {
  const docs: IndexedDoc[] = entries.map((entry) => {
    const combined = [entry.title, entry.summary, entry.sections.join(' '), entry.tags.join(' ')]
      .join(' ')
      .trim();
    const tokens = new Set<string>(tokenize(combined));
    const titleTokens = new Set<string>(tokenize(entry.title));
    const sentenceTokens = splitIntoSentences([entry.summary, ...entry.sections].join(' ')).map(
      (sentence) => ({
        text: sentence,
        tokens: new Set<string>(tokenize(sentence)),
      })
    );
    return {
      ...entry,
      tokens,
      titleTokens,
      sentenceTokens,
    };
  });
  const map = new Map<string, IndexedDoc>();
  for (const doc of docs) {
    map.set(doc.id, doc);
  }
  return { docs, map };
}

const { docs: INDEXED_DOCS, map: INDEXED_DOC_MAP } = indexDocs(DOCS_INDEX);

function scoreDoc(doc: IndexedDoc, tokens: readonly string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  let score = 0;
  const uniqueTokens = new Set(tokens);
  for (const token of uniqueTokens) {
    if (doc.titleTokens.has(token)) {
      score += 2;
    } else if (doc.tokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

function findHighlight(doc: IndexedDoc, tokens: readonly string[]): string {
  for (const sentence of doc.sentenceTokens) {
    for (const token of tokens) {
      if (sentence.tokens.has(token)) {
        return sentence.text;
      }
    }
  }
  return doc.summary;
}

// Input schemas
const searchDocsInputSchema = z.object({
  query: z.string().min(2).max(200),
  limit: z.number().int().positive().max(10).optional(),
});

const docSummaryInputSchema = z.object({
  docId: z.string().min(1).max(120),
});

async function executeSearchDocs(input: unknown): Promise<ToolExecutionResult> {
  const startTime = performance.now();
  try {
    const parsed = searchDocsInputSchema.parse(input);
    const query = parsed.query.trim();
    const limit = parsed.limit ?? 5;

    const queryTokens = tokenize(query).slice(0, 8);
    if (queryTokens.length === 0) {
      return {
        success: true,
        result: { query, limit, totalResults: 0, results: [] },
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    const ranked: Array<{ doc: IndexedDoc; score: number; highlight: string }> = [];
    for (const doc of INDEXED_DOCS) {
      const score = scoreDoc(doc, queryTokens);
      if (score > 0) {
        ranked.push({ doc, score, highlight: findHighlight(doc, queryTokens) });
      }
    }

    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.doc.title.localeCompare(b.doc.title);
    });

    const results = ranked.slice(0, limit).map(({ doc, score, highlight }) => ({
      id: doc.id,
      title: doc.title,
      summary: doc.summary,
      url: doc.url,
      highlight,
      tags: doc.tags,
      score,
    }));

    return {
      success: true,
      result: {
        query,
        limit,
        totalResults: ranked.length,
        tookMs: Math.round(performance.now() - startTime),
        results,
      },
      durationMs: Math.round(performance.now() - startTime),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Search failed',
      durationMs: Math.round(performance.now() - startTime),
    };
  }
}

async function executeDocSummary(input: unknown): Promise<ToolExecutionResult> {
  const startTime = performance.now();
  try {
    const parsed = docSummaryInputSchema.parse(input);
    const docId = parsed.docId.trim();
    const doc = INDEXED_DOC_MAP.get(docId);

    if (!doc) {
      return {
        success: false,
        error: `Document not found: ${docId}`,
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    const sections = doc.sections.map((text, index) => ({
      id: `${doc.id}-section-${index + 1}`,
      text,
    }));

    return {
      success: true,
      result: {
        doc: {
          id: doc.id,
          title: doc.title,
          summary: doc.summary,
          url: doc.url,
          tags: doc.tags,
          sections,
          ...(doc.versionIntroduced ? { versionIntroduced: doc.versionIntroduced } : {}),
        },
      },
      durationMs: Math.round(performance.now() - startTime),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get document summary',
      durationMs: Math.round(performance.now() - startTime),
    };
  }
}

/**
 * Execute a native tool by ID with the given input.
 */
export async function executeNativeTool(
  toolId: string,
  input: unknown
): Promise<ToolExecutionResult> {
  const startTime = performance.now();

  logger.debug('Executing native tool', { toolId });

  switch (toolId) {
    case 'web.searchDocs':
      return executeSearchDocs(input);
    case 'web.docSummary':
      return executeDocSummary(input);
    default:
      return {
        success: false,
        error: `Native tool '${toolId}' is not supported for playground execution. Database-dependent tools require an active embedding set.`,
        durationMs: Math.round(performance.now() - startTime),
      };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/desktop -- native-tool-executor`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/desktop/src/native-tool-executor.ts apps/desktop/src/__tests__/main/native-tool-executor.test.ts
git commit -m "feat(desktop): add native tool executor for playground"
```

---

## Task 3: Create IPC Tools Handler

**Files:**
- Create: `apps/desktop/src/ipc-tools.ts`
- Create: `apps/desktop/src/__tests__/main/ipc-tools.test.ts`

**Step 1: Write the test file**

Create `apps/desktop/src/__tests__/main/ipc-tools.test.ts`:

```typescript
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

// Mock native tool executor
vi.mock('../../native-tool-executor', () => ({
  executeNativeTool: vi.fn(),
  isExecutableNativeTool: vi.fn(),
}));

// Mock MCP callTool
vi.mock('../../mcp', () => ({
  callTool: vi.fn(),
}));

import { ipcMain } from 'electron';
import { callTool } from '../../mcp';
import { executeNativeTool, isExecutableNativeTool } from '../../native-tool-executor';

describe('ipc-tools', () => {
  let toolsExecuteHandler: (
    event: IpcMainInvokeEvent,
    toolId: string,
    input: unknown
  ) => Promise<unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import and register handlers
    const { registerToolsIpcHandlers } = await import('../../ipc-tools');
    registerToolsIpcHandlers();

    // Extract the registered handler
    const handleCalls = vi.mocked(ipcMain.handle).mock.calls;
    const toolsCall = handleCalls.find(([channel]) => channel === 'tools:execute');
    if (!toolsCall) {
      throw new Error('tools:execute handler not registered');
    }
    toolsExecuteHandler = toolsCall[1] as typeof toolsExecuteHandler;
  });

  afterEach(() => {
    vi.resetModules();
  });

  const mockEvent = {} as IpcMainInvokeEvent;

  describe('tools:execute', () => {
    it('executes native tools via executeNativeTool', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(true);
      vi.mocked(executeNativeTool).mockResolvedValue({
        success: true,
        result: { data: 'test' },
        durationMs: 10,
      });

      const result = await toolsExecuteHandler(mockEvent, 'web.searchDocs', { query: 'test' });

      expect(isExecutableNativeTool).toHaveBeenCalledWith('web.searchDocs');
      expect(executeNativeTool).toHaveBeenCalledWith('web.searchDocs', { query: 'test' });
      expect(result).toEqual({
        success: true,
        result: { data: 'test' },
        durationMs: 10,
      });
    });

    it('executes MCP tools via callTool', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(callTool).mockResolvedValue({ mcpResult: 'success' });

      const result = await toolsExecuteHandler(mockEvent, 'mcp__server__tool', { param: 'value' });

      expect(isExecutableNativeTool).toHaveBeenCalledWith('mcp__server__tool');
      expect(callTool).toHaveBeenCalledWith('mcp__server__tool', { param: 'value' });
      expect(result).toMatchObject({
        success: true,
        result: { mcpResult: 'success' },
      });
    });

    it('returns error for unsupported native tools', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(callTool).mockRejectedValue(new Error("No MCP client registered for 'brainstrike'"));

      const result = await toolsExecuteHandler(mockEvent, 'brainstrike.retrieveContext', {});

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('No MCP client'),
      });
    });

    it('handles MCP tool execution errors', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(callTool).mockRejectedValue(new Error('MCP server disconnected'));

      const result = await toolsExecuteHandler(mockEvent, 'mcp__server__tool', {});

      expect(result).toMatchObject({
        success: false,
        error: 'MCP server disconnected',
      });
    });

    it('includes durationMs in all responses', async () => {
      vi.mocked(isExecutableNativeTool).mockReturnValue(false);
      vi.mocked(callTool).mockResolvedValue({ data: 'test' });

      const result = (await toolsExecuteHandler(mockEvent, 'mcp__tool', {})) as {
        durationMs: number;
      };

      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test --filter @brainstrike/desktop -- ipc-tools.test`
Expected: FAIL with "Cannot find module"

**Step 3: Create the IPC handler**

Create `apps/desktop/src/ipc-tools.ts`:

```typescript
/**
 * IPC Handlers for Tool Execution
 *
 * Provides the bridge between renderer process (Tool Playground) and
 * tool execution in the main process.
 */

import { createLogger } from '@brainstrike/utils';
import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import { callTool } from './mcp';
import { executeNativeTool, isExecutableNativeTool } from './native-tool-executor';

const logger = createLogger('IpcTools');

/**
 * Result of executing a tool via IPC.
 */
interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * Register IPC handlers for tool execution.
 */
export function registerToolsIpcHandlers(): void {
  logger.info('Registering tools IPC handlers');

  ipcMain.handle(
    'tools:execute',
    async (
      _event: IpcMainInvokeEvent,
      toolId: string,
      input: unknown
    ): Promise<ToolExecutionResult> => {
      const startTime = performance.now();
      logger.debug('Executing tool', { toolId });

      try {
        // Check if it's an executable native tool
        if (isExecutableNativeTool(toolId)) {
          return await executeNativeTool(toolId, input);
        }

        // Try MCP tool execution
        const result = await callTool(toolId, input as Record<string, unknown>);

        return {
          success: true,
          result,
          durationMs: Math.round(performance.now() - startTime),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Tool execution failed';
        logger.error('Tool execution failed', { toolId, error: errorMessage });

        return {
          success: false,
          error: errorMessage,
          durationMs: Math.round(performance.now() - startTime),
        };
      }
    }
  );
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test --filter @brainstrike/desktop -- ipc-tools.test`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/desktop/src/ipc-tools.ts apps/desktop/src/__tests__/main/ipc-tools.test.ts
git commit -m "feat(desktop): add IPC handler for tool execution"
```

---

## Task 4: Register IPC Handler in Main Process

**Files:**
- Modify: `apps/desktop/src/main.ts`

**Step 1: Find the IPC registration section**

Look for where other IPC handlers are registered (near `registerMcpIpcHandlers`).

**Step 2: Add the tools IPC handler registration**

Add import at top of `apps/desktop/src/main.ts`:

```typescript
import { registerToolsIpcHandlers } from './ipc-tools';
```

Add registration call near other IPC registrations (after `registerMcpIpcHandlers()`):

```typescript
registerToolsIpcHandlers();
```

**Step 3: Verify build succeeds**

Run: `pnpm build --filter @brainstrike/desktop`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "feat(desktop): register tools IPC handler in main process"
```

---

## Task 5: Wire Up Renderer executeToolTest

**Files:**
- Modify: `apps/desktop/src/renderer/components/settings/page-content.tsx`

**Step 1: Update executeToolTest to use IPC bridge**

Find the `executeToolTest` function in `toolOperations` (around line 215) and replace the stub:

```typescript
executeToolTest: async (toolId: string, input: unknown) => {
  // Execute tool via IPC bridge to main process
  if (window.tools?.execute) {
    return window.tools.execute(toolId, input);
  }
  // Fallback if tools API not available
  return {
    success: false,
    error: 'Tool execution API not available',
    durationMs: 0,
  };
},
```

**Step 2: Verify types compile**

Run: `pnpm type-check --filter @brainstrike/desktop`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/components/settings/page-content.tsx
git commit -m "feat(desktop): wire executeToolTest to IPC bridge"
```

---

## Task 6: Integration Test

**Files:**
- Modify: `apps/desktop/src/__tests__/main/ipc-tools.test.ts` (add integration scenarios)

**Step 1: Add integration test for full flow**

Add to the test file:

```typescript
describe('integration', () => {
  it('web.searchDocs returns search results', async () => {
    // Reset mocks to use real implementation
    vi.mocked(isExecutableNativeTool).mockRestore();
    vi.mocked(executeNativeTool).mockRestore();

    // Re-import real modules
    const realModule = await vi.importActual<typeof import('../../native-tool-executor')>(
      '../../native-tool-executor'
    );

    vi.mocked(isExecutableNativeTool).mockImplementation(realModule.isExecutableNativeTool);
    vi.mocked(executeNativeTool).mockImplementation(realModule.executeNativeTool);

    const result = (await toolsExecuteHandler(mockEvent, 'web.searchDocs', {
      query: 'assistant',
      limit: 3,
    })) as { success: boolean; result?: { results: unknown[] } };

    expect(result.success).toBe(true);
    expect(result.result?.results).toBeDefined();
    expect(Array.isArray(result.result?.results)).toBe(true);
  });
});
```

**Step 2: Run all tests**

Run: `pnpm test --filter @brainstrike/desktop -- ipc-tools`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/desktop/src/__tests__/main/ipc-tools.test.ts
git commit -m "test(desktop): add integration test for tool execution"
```

---

## Task 7: Final Validation

**Step 1: Run full test suite**

Run: `pnpm test --filter @brainstrike/desktop`
Expected: All tests PASS

**Step 2: Run type check**

Run: `pnpm type-check --filter @brainstrike/desktop`
Expected: PASS

**Step 3: Run lint**

Run: `pnpm lint --filter @brainstrike/desktop`
Expected: PASS (or only pre-existing warnings)

**Step 4: Build desktop app**

Run: `pnpm build --filter @brainstrike/desktop`
Expected: PASS

**Step 5: Create final commit if any fixes needed**

```bash
git add -A
git commit -m "chore(desktop): fix any remaining issues from tool execution implementation"
```

---

## Summary

After completing all tasks, the Tool Playground will be able to execute:

1. **Web tools** (`web.searchDocs`, `web.docSummary`) - Execute immediately using the native executor
2. **MCP tools** - Execute through the MCP client system (requires MCP servers to be configured)

**Not yet supported** (would need additional work):
- Database-dependent native tools (`brainstrike.retrieveContext`, `brainstrike.hybridSearch`) - These require an active embedding set and database connection. The executor returns a helpful error message explaining this.

**Test coverage:**
- Unit tests for `native-tool-executor.ts`
- Unit tests for `ipc-tools.ts` IPC handlers
- Integration tests for end-to-end flow
