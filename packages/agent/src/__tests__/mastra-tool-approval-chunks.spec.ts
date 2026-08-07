/**
 * BST-988: the pause slice of the Mastra stream boundary.
 *
 * Two seams, kept together because they are two halves of one contract:
 *   - `mastra/tool-approval-chunks.ts` (BST-986) mints the pause —
 *     `makeApprovalRequiredChunks` / `makeToolSuspendRequiredChunks`, tool-name
 *     denormalization, ask-tool risk metadata, and the MALFORMED-pause terminal.
 *   - `streamMastraToolApprovalAction` / `streamMastraToolResumeAction` in
 *     `agent-streaming.ts` consume it and resume the run.
 * A pause that cannot be resumed is a bug in the PAIR, so splitting them across
 * two files would let either side stay green while the contract broke.
 *
 * Every test here was MOVED unchanged from `mastra-streaming.spec.ts`.
 *
 * See docs/agents/assistant-runtime.md (PERMISSION ENGINE, tool suspend/resume).
 */
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listSuspendedMastraRuns,
  streamMastraAgent,
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
} from '../mastra/agent-streaming';
import {
  agentInstances,
  expectLeadingContextBreakdown,
  expectMastraAgentError,
  findRunEventChunks,
  mastraInstances,
  mcpInstances,
  resetMastraStreamHarness,
  setMockStreamParts,
  setSuspendedRuns,
} from './fixtures/mastra-stream-harness';

vi.mock(
  '@ai-sdk/openai',
  async () => (await import('./fixtures/mastra-stream-harness')).openAiSdkMock
);

vi.mock(
  '@ai-sdk/anthropic',
  async () => (await import('./fixtures/mastra-stream-harness')).anthropicSdkMock
);

vi.mock(
  '@ai-sdk/google',
  async () => (await import('./fixtures/mastra-stream-harness')).googleSdkMock
);

vi.mock(
  '@mastra/core/agent',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraAgentModuleMock
);

vi.mock(
  '@mastra/core/mastra',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraCoreModuleMock
);

vi.mock(
  '../mcp/explicit-stdio-client',
  async () => (await import('./fixtures/mastra-stream-harness')).explicitStdioMcpClientModuleMock
);

describe('mastra streaming: tool approval and suspend pauses', () => {
  beforeEach(() => {
    resetMastraStreamHarness();
  });

  it('passes tool approval through as a pending non-error stream state', async () => {
    setMockStreamParts([
      {
        payload: {
          args: { mode: 'replace', paths: ['src/index.ts'] },
          resumeSchema: '{}',
          toolCallId: 'approval-1',
          toolName: 'brainstrike.updateWorkspaceContextSelection',
        },
        runId: 'run-approval-1',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'update selected context', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const streamOptions = agentInstances.at(-1)?.streamCalls.at(-1)?.options as {
      requireToolApproval?: boolean;
    };
    expect(streamOptions.requireToolApproval).toBe(true);
    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      {
        args: { mode: 'replace', paths: ['src/index.ts'] },
        resumeSchema: '{}',
        runId: 'run-approval-1',
        toolCallId: 'approval-1',
        toolName: 'brainstrike.updateWorkspaceContextSelection',
        type: 'tool-approval-required',
      },
      {
        finishReason: 'tool-calls',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  it('denormalizes a native approval tool name when no sanitized name map entry exists', async () => {
    // NAME-FORM CONTRACT: the client-facing `toolName` is ALWAYS the original
    // dotted name. The runtime `toolNameMap` is the primary bridge, but it only
    // holds tools registered on THIS runtime — no `tools` are passed here, which
    // mirrors the real no-tools stream route (apps/desktop/src/ipc-agent.ts).
    // Without the static native reverse map the approval UI would label the
    // pause with the raw sanitized id (`brainstrike_executeCommand`).
    setMockStreamParts([
      {
        payload: {
          args: { command: 'echo hi' },
          toolCallId: 'approval-denormalize-1',
          toolName: 'brainstrike_executeCommand',
        },
        runId: 'run-approval-denormalize-1',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'run a command', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      {
        args: { command: 'echo hi' },
        runId: 'run-approval-denormalize-1',
        toolCallId: 'approval-denormalize-1',
        toolName: 'brainstrike.executeCommand',
        type: 'tool-approval-required',
      },
      {
        finishReason: 'tool-calls',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  it('denormalizes a native tool name on an UNSUPPORTED approval pause with no sanitized name map entry', async () => {
    // Same name-form contract on the malformed-pause branch: a pause missing the
    // tool call id still terminates visibly, and the tool-event name + the
    // `run.failed` metadata it carries are the ONLY names the user sees, so they
    // must be dotted too.
    setMockStreamParts([
      {
        payload: {
          args: { command: 'echo hi' },
          toolName: 'brainstrike_executeCommand',
        },
        runId: 'run-approval-denormalize-unsupported',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'run a command', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      expect.objectContaining({
        name: 'brainstrike.executeCommand',
        status: 'error',
        type: 'tool-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'run.failed',
          metadata: expect.objectContaining({ toolName: 'brainstrike.executeCommand' }),
        }),
        type: 'run-event',
      }),
      {
        finishReason: 'error',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  it('keeps a MAPPED approval tool name authoritative even when it looks like a sanitized native id', async () => {
    // ORDERING half of the two-layer contract: the runtime `toolNameMap` WINS and
    // the static native reverse map is only a fallback. `sanitizeTools` records
    // `map.set(uniqueName, name)` unconditionally, so a tool registered under the
    // literal underscored id gets the IDENTITY mapping
    // `brainstrike_executeCommand -> brainstrike_executeCommand`. Denormalizing a
    // successful hit would rewrite that authoritative original to
    // `brainstrike.executeCommand` and mislabel the notice / submit the wrong id
    // to per-tool grant handling.
    setMockStreamParts([
      {
        payload: {
          args: { command: 'echo hi' },
          toolCallId: 'approval-mapped-native-lookalike',
          toolName: 'brainstrike_executeCommand',
        },
        runId: 'run-approval-mapped-native-lookalike',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'run a command', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: {
          brainstrike_executeCommand: {
            description: 'Caller-owned tool whose original id is already underscored.',
            id: 'brainstrike_executeCommand',
          },
        },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        toolCallId: 'approval-mapped-native-lookalike',
        toolName: 'brainstrike_executeCommand',
        type: 'tool-approval-required',
      })
    );
  });

  it('passes an underscored NON-native approval tool name through unchanged', async () => {
    // The static reverse map only reverses KNOWN native ids: an underscore in an
    // unknown/MCP name could be original, so a blind `_`→`.` swap would fabricate
    // a wrong dotted name (no-silent-fallbacks). No `tools` are registered here,
    // so this exercises the fallback layer with a name it must NOT touch.
    setMockStreamParts([
      {
        payload: {
          args: { command: 'echo hi' },
          toolCallId: 'approval-unknown-underscored',
          toolName: 'totally_unknown_tool',
        },
        runId: 'run-approval-unknown-underscored',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'run a command', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        toolCallId: 'approval-unknown-underscored',
        toolName: 'totally_unknown_tool',
        type: 'tool-approval-required',
      })
    );
  });

  it('resolves ask-tool risk metadata when the approval part carries the ORIGINAL dotted name (dual-form lookup)', async () => {
    // askTools is keyed by the SANITIZED registered id; a Mastra upgrade (or any
    // path that surfaces the pause under the ORIGINAL dotted name) must not
    // silently drop the risk metadata — the lookup bridges both name forms.
    setMockStreamParts([
      {
        payload: {
          args: { command: 'echo hi' },
          toolCallId: 'approval-dotted-1',
          // ORIGINAL dotted name, NOT the registered sanitized id.
          toolName: 'brainstrike.runShell',
        },
        runId: 'run-approval-dotted-1',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-dotted', parts: [{ text: 'run it', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          permissionPolicy: {
            policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
            riskByTool: { 'brainstrike.runShell': 'execute' },
            yolo: false,
          },
          provider: 'openai',
        },
        storage: { id: 'workflow-storage' } as never,
        tools: {
          'brainstrike.runShell': { description: 'run shell', id: 'brainstrike.runShell' },
        },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        policyDecision: 'ask',
        riskCategory: 'execute',
        runId: 'run-approval-dotted-1',
        toolCallId: 'approval-dotted-1',
        toolName: 'brainstrike.runShell',
        type: 'tool-approval-required',
      })
    );
  });

  it('logs a LOUD error and omits risk metadata when a policy-driven pause cannot be resolved (never fabricates)', async () => {
    // A policy-driven run (non-empty askTools) that pauses on a tool the
    // metadata lookup cannot resolve under EITHER name form must surface the
    // pause honestly — no riskCategory, no policyDecision — and log an error so
    // the metadata drop is observable (no silent fallback).
    setMockStreamParts([
      {
        payload: {
          args: { command: 'echo hi' },
          toolCallId: 'approval-unresolved-1',
          toolName: 'totally.unknownTool',
        },
        runId: 'run-approval-unresolved-1',
        type: 'tool-call-approval',
      },
    ]);

    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    const chunks: unknown[] = [];
    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u-unresolved', parts: [{ text: 'run it', type: 'text' }], role: 'user' }],
        {
          runtime: {
            apiKey: 'test-key',
            permissionPolicy: {
              policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
              riskByTool: { 'brainstrike.runShell': 'execute' },
              yolo: false,
            },
            provider: 'openai',
          },
          storage: { id: 'workflow-storage' } as never,
          tools: {
            'brainstrike.runShell': { description: 'run shell', id: 'brainstrike.runShell' },
          },
        }
      );
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    } finally {
      removeLogListener();
    }

    const approvalChunk = chunks.find(
      (chunk): chunk is Record<string, unknown> =>
        Boolean(chunk && typeof chunk === 'object') &&
        (chunk as { type?: unknown }).type === 'tool-approval-required'
    );
    // The pause still surfaces (the user can approve/decline)…
    expect(approvalChunk).toMatchObject({
      toolCallId: 'approval-unresolved-1',
      toolName: 'totally.unknownTool',
    });
    // …but the metadata is honestly omitted, never fabricated.
    expect(approvalChunk).not.toHaveProperty('riskCategory');
    expect(approvalChunk).not.toHaveProperty('policyDecision');
    // And the drop is LOUD.
    const unresolvedLog = logRecords.find(
      (record) =>
        record.level === LogLevel.ERROR &&
        record.args.some(
          (arg) =>
            Boolean(arg && typeof arg === 'object') &&
            (arg as { code?: unknown }).code === 'mastra_agent_approval_metadata_unresolved'
        )
    );
    expect(unresolvedLog).toBeDefined();
  });

  it('keeps an OpenRouter tool approval resumable before Mastra emits step-finish', async () => {
    setMockStreamParts([
      {
        payload: {
          args: { path: 'src/index.ts' },
          toolCallId: 'approval-cost-1',
          toolName: 'brainstrike.writeWorkspaceFile',
        },
        runId: 'run-approval-cost-1',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-cost-approval', parts: [{ text: 'edit the file', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openrouter' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      finishReason: 'tool-calls',
      path: [],
      type: 'message-finish',
      usage: { completionTokens: 0, promptTokens: 0 },
    });
  });

  it('flushes output-only tool completions before an approval pause', async () => {
    setMockStreamParts([
      {
        args: { query: 'local state' },
        toolCallId: 'c-output-only-before-approval',
        toolName: 'background.lookup',
        type: 'tool-call',
      },
      {
        output: { answer: 'done' },
        toolCallId: 'c-output-only-before-approval',
        type: 'tool-output',
      },
      {
        payload: {
          args: { mode: 'replace', paths: ['src/index.ts'] },
          resumeSchema: '{}',
          toolCallId: 'approval-1',
          toolName: 'brainstrike.updateWorkspaceContextSelection',
        },
        runId: 'run-approval-1',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'lookup then approve', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      expect.objectContaining({
        name: 'background.lookup',
        status: 'start',
        type: 'tool-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool.started',
          metadata: expect.objectContaining({
            toolCallId: 'c-output-only-before-approval',
            toolName: 'background.lookup',
          }),
        }),
        type: 'run-event',
      }),
      expect.objectContaining({
        name: 'background.lookup',
        status: 'success',
        type: 'tool-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool.completed',
          metadata: expect.objectContaining({
            toolCallId: 'c-output-only-before-approval',
            toolName: 'background.lookup',
          }),
          status: 'completed',
        }),
        type: 'run-event',
      }),
      {
        args: { mode: 'replace', paths: ['src/index.ts'] },
        resumeSchema: '{}',
        runId: 'run-approval-1',
        toolCallId: 'approval-1',
        toolName: 'brainstrike.updateWorkspaceContextSelection',
        type: 'tool-approval-required',
      },
      {
        finishReason: 'tool-calls',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  it('resumes an approved Mastra tool call through the official approval API', async () => {
    const memory = { id: 'memory-instance' };
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      { textDelta: 'Approved and continued.', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 3, promptTokens: 2 } },
    ]);

    const iterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: 'run-approval-1',
        toolCallId: 'tool-call-1',
        toolName: 'workspace.writeFile',
      },
      {
        memory: memory as never,
        requireToolApproval: true,
        runtime: {
          agentLoop: { inputTokenLimit: 8192 },
          apiKey: 'test-key',
          assistantMessageId: 'assistant-resume-id',
          memory: {
            memoryOptions: { lastMessages: 5 },
            resourceId: 'workspace-a',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        storage: storage as never,
      }
    );

    const agent = agentInstances.at(-1);
    const approvalOptions = agent?.approveToolCallCalls[0] as {
      experimental_generateMessageId?: () => string;
      inputProcessors?: Array<{ id?: string }>;
    };
    const mastraConfig = mastraInstances.at(-1)?.config as {
      idGenerator?: () => string;
    };
    expect(approvalOptions.experimental_generateMessageId).toBeTypeOf('function');
    expect(approvalOptions.experimental_generateMessageId?.()).toBe('assistant-resume-id');
    expect(approvalOptions.inputProcessors?.map((processor) => processor.id)).toEqual([
      'tool-call-filter',
      'provider-history-compat',
      'openai-tool-search-history-compat',
      'openai-duplicate-item-compat',
      'token-limiter',
    ]);
    expect(mastraConfig.idGenerator?.()).toBe('assistant-resume-id');

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(agent?.approveToolCallCalls).toHaveLength(1);
    expect(agent?.declineToolCallCalls).toHaveLength(0);
    expect(agent?.approveToolCallCalls[0]).toMatchObject({
      maxSteps: 100,
      memory: {
        options: { lastMessages: 5 },
        resource: 'workspace-a',
        thread: 'thread-1',
      },
      runId: 'run-approval-1',
      toolCallId: 'tool-call-1',
    });
    // This fixture has no permission-policy ask set, so the approval was
    // explicitly global. The resumed leg must keep gating every non-internal
    // follow-up tool while exempting Mastra's memory bookkeeping.
    const approveGate = (
      agent?.approveToolCallCalls[0] as { requireToolApproval?: unknown } | undefined
    )?.requireToolApproval as (ctx: { toolName: string }) => boolean;
    expect(typeof approveGate).toBe('function');
    expect(approveGate({ toolName: 'updateWorkingMemory' })).toBe(false);
    expect(approveGate({ toolName: 'brainstrike_writeWorkspaceFile' })).toBe(true);
    // Self-approving tools are NOT exempt from the explicit-global posture:
    // with no permission snapshot their in-tool Gate A resolves 'allow' and
    // is inert, so the global gate is the only prompt run_python would get
    // here (BST-1097 review — the ask-set exemption must not leak into this
    // posture).
    expect(approveGate({ toolName: 'brainstrike_runPython' })).toBe(true);
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'Approved and continued.' });
    expect(chunks).toContainEqual({
      finishReason: 'stop',
      path: [],
      type: 'message-finish',
      usage: {
        completionTokens: 3,
        contextInputTokens: 2,
        contextOutputTokens: 3,
        promptTokens: 2,
      },
    });
  });

  it('re-gates EVERY enforced ask-set tool on the resume leg — run_python included (BST-1097, 1.56+ idiom)', async () => {
    // Since the @mastra/core 1.56 approval rework there is no self-approving
    // exemption: run_python is an ordinary ask-set tool whose Gate A is the
    // permission gate's requireApproval clone, so re-gating it on a resumed
    // leg matches the framework's own idiom — the approval is consumed
    // pre-execution and the tool runs once, never a loop.
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      { textDelta: 'ok', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: 'run-approval-1',
        toolCallId: 'tool-call-1',
        toolName: 'workspace.writeFile',
      },
      {
        requireToolApproval: true,
        runtime: {
          apiKey: 'test-key',
          permissionPolicy: {
            policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
            riskByTool: { 'brainstrike.runPython': 'execute', 'workspace.writeFile': 'edit' },
            yolo: false,
          },
          provider: 'openai',
        },
        storage: storage as never,
        tools: {
          'brainstrike.runPython': {
            execute: async () => ({}),
            id: 'brainstrike.runPython',
            resumeSchema: {},
            suspendSchema: {},
          },
          'workspace.writeFile': { execute: async () => ({}), id: 'workspace.writeFile' },
        },
      }
    );
    for await (const _chunk of iterator) {
      // drain
    }

    const enforcedGate = (
      agentInstances.at(-1)?.approveToolCallCalls[0] as
        | { requireToolApproval?: unknown }
        | undefined
    )?.requireToolApproval as (ctx: { toolName: string }) => boolean;
    expect(typeof enforcedGate).toBe('function');
    // run_python is an ordinary ask-set tool now — gated like everything else.
    expect(enforcedGate({ toolName: 'brainstrike_runPython' })).toBe(true);
    // Ordinary ask tool on the same leg stays gated.
    expect(enforcedGate({ toolName: 'workspace_writeFile' })).toBe(true);
    // Mastra-internal working-memory bookkeeping stays exempt (D4).
    expect(enforcedGate({ toolName: 'updateWorkingMemory' })).toBe(false);
  });

  it('keeps a suspended-tool resume stream ID independent from its persisted ID', async () => {
    const storage = { id: 'workflow-storage' };
    // The resume path verifies against the storage snapshot that the target
    // call is suspended on a PLAIN suspend() pause (BST-1097's
    // assertResumedCallIsSuspendPause) before resuming, so the run must exist
    // in the discovery fixture as a NON-approval pause.
    setSuspendedRuns([
      {
        runId: 'run-suspended-1',
        status: 'suspended',
        suspendedAt: new Date('2026-07-21T00:00:00Z'),
        toolCalls: [
          {
            args: {},
            requiresApproval: false,
            suspendPayload: { question: 'Which city?' },
            toolCallId: 'tool-call-suspended-1',
            toolName: 'brainstrike_askUser',
          },
        ],
      },
    ]);
    setMockStreamParts([
      { textDelta: 'Resumed and continued.', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraToolResumeAction(
      {
        resumeData: { answer: 'Paris' },
        runId: 'run-suspended-1',
        toolCallId: 'tool-call-suspended-1',
      },
      {
        runtime: {
          agentLoop: { inputTokenLimit: 8192 },
          apiKey: 'test-key',
          assistantMessageId: 'assistant-suspend-resume-id',
          provider: 'openai',
        },
        storage: storage as never,
      }
    );

    const agent = agentInstances.at(-1);
    const resumeOptions = agent?.resumeStreamCalls[0]?.options as {
      experimental_generateMessageId?: () => string;
      inputProcessors?: Array<{ id?: string }>;
    };
    const mastraConfig = mastraInstances.at(-1)?.config as {
      idGenerator?: () => string;
    };
    expect(resumeOptions.experimental_generateMessageId).toBeTypeOf('function');
    expect(resumeOptions.experimental_generateMessageId?.()).toBe('assistant-suspend-resume-id');
    expect(resumeOptions.inputProcessors?.map((processor) => processor.id)).toEqual([
      'tool-call-filter',
      'provider-history-compat',
      'openai-tool-search-history-compat',
      'openai-duplicate-item-compat',
      'token-limiter',
    ]);
    expect(mastraConfig.idGenerator?.()).toBe('assistant-suspend-resume-id');

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(agent?.resumeStreamCalls[0]).toMatchObject({
      options: {
        maxSteps: 100,
        runId: 'run-suspended-1',
        toolCallId: 'tool-call-suspended-1',
      },
      resumeData: { answer: 'Paris' },
    });
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'Resumed and continued.' });
    expect(chunks).toContainEqual(
      expect.objectContaining({ finishReason: 'stop', type: 'message-finish' })
    );
  });

  it("attaches the 1.56+ approved rider to an ask-gated tool's OBJECT resume payload (BST-1097 idiom)", async () => {
    // A plain suspension can only be raised from inside execute(), which the
    // framework only reaches after the call's pre-execution gate settled — the
    // rider states that historical fact so Mastra's per-leg re-check cannot
    // convert the resume into a denial.
    const storage = { id: 'workflow-storage' };
    setSuspendedRuns([
      {
        runId: 'run-rider-1',
        status: 'suspended',
        suspendedAt: new Date('2026-08-07T00:00:00Z'),
        toolCalls: [
          {
            args: {},
            requiresApproval: false,
            suspendPayload: { allowedDomains: ['pypi.org'], kind: 'network' },
            toolCallId: 'tool-call-rider-1',
            toolName: 'brainstrike_runPython',
          },
        ],
      },
    ]);
    setMockStreamParts([
      { textDelta: 'ok', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraToolResumeAction(
      {
        resumeData: { action: 'allow' },
        runId: 'run-rider-1',
        toolCallId: 'tool-call-rider-1',
        toolName: 'brainstrike.runPython',
      },
      {
        runtime: {
          apiKey: 'test-key',
          permissionPolicy: {
            policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
            riskByTool: { 'brainstrike.runPython': 'execute' },
            yolo: false,
          },
          provider: 'openai',
        },
        storage: storage as never,
        tools: {
          'brainstrike.runPython': {
            execute: async () => ({}),
            id: 'brainstrike.runPython',
            resumeSchema: {},
            suspendSchema: {},
          },
        },
      }
    );
    for await (const _chunk of iterator) {
      // drain
    }

    expect(agentInstances.at(-1)?.resumeStreamCalls[0]?.resumeData).toEqual({
      action: 'allow',
      approved: true,
    });
  });

  it('passes a NON-OBJECT resume payload through untouched even for an ask-gated tool — never mangled into an index map', async () => {
    // askUser's resume is a bare string/array; spreading it would corrupt it.
    // The rider is skipped (loud warn at the transport), and the payload
    // reaches Mastra byte-identical.
    const storage = { id: 'workflow-storage' };
    setSuspendedRuns([
      {
        runId: 'run-rider-2',
        status: 'suspended',
        suspendedAt: new Date('2026-08-07T00:00:00Z'),
        toolCalls: [
          {
            args: {},
            requiresApproval: false,
            suspendPayload: { question: 'Proceed?' },
            toolCallId: 'tool-call-rider-2',
            toolName: 'brainstrike_askUser',
          },
        ],
      },
    ]);
    setMockStreamParts([
      { textDelta: 'ok', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraToolResumeAction(
      {
        resumeData: 'yes, proceed',
        runId: 'run-rider-2',
        toolCallId: 'tool-call-rider-2',
        toolName: 'brainstrike.askUser',
      },
      {
        runtime: {
          apiKey: 'test-key',
          permissionPolicy: {
            policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
            riskByTool: { 'brainstrike.askUser': 'read' },
            yolo: false,
          },
          provider: 'openai',
        },
        storage: storage as never,
        tools: {
          'brainstrike.askUser': {
            execute: async () => ({}),
            id: 'brainstrike.askUser',
            resumeSchema: {},
            suspendSchema: {},
          },
        },
      }
    );
    for await (const _chunk of iterator) {
      // drain
    }

    expect(agentInstances.at(-1)?.resumeStreamCalls[0]?.resumeData).toBe('yes, proceed');
  });

  it("leaves an un-gated tool's object resume payload rider-free — Mastra will not re-check it", async () => {
    const storage = { id: 'workflow-storage' };
    setSuspendedRuns([
      {
        runId: 'run-rider-3',
        status: 'suspended',
        suspendedAt: new Date('2026-08-07T00:00:00Z'),
        toolCalls: [
          {
            args: {},
            requiresApproval: false,
            suspendPayload: { allowedDomains: ['pypi.org'], kind: 'network' },
            toolCallId: 'tool-call-rider-3',
            toolName: 'brainstrike_runPython',
          },
        ],
      },
    ]);
    setMockStreamParts([
      { textDelta: 'ok', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraToolResumeAction(
      {
        resumeData: { action: 'allow' },
        runId: 'run-rider-3',
        toolCallId: 'tool-call-rider-3',
        toolName: 'brainstrike.runPython',
      },
      {
        // No permission policy → nothing is ask-gated → no re-check, no rider.
        runtime: { apiKey: 'test-key', provider: 'openai' },
        storage: storage as never,
        tools: {
          'brainstrike.runPython': {
            execute: async () => ({}),
            id: 'brainstrike.runPython',
            resumeSchema: {},
            suspendSchema: {},
          },
        },
      }
    );
    for await (const _chunk of iterator) {
      // drain
    }

    expect(agentInstances.at(-1)?.resumeStreamCalls[0]?.resumeData).toEqual({ action: 'allow' });
  });

  it('REFUSES to resume an APPROVAL pause through the suspend-resume transport (BST-1097)', async () => {
    // The two pause kinds carry different resume shapes. A generic resume
    // payload delivered to an approval pause would reach a self-approving
    // tool as if its gates were settled — {action:'allow'} answering
    // run_python's Gate A would skip the approval card entirely. The default
    // fixtures list run-approval-1/tool-call-1 as requiresApproval: true.
    const storage = { id: 'workflow-storage' };
    await expectMastraAgentError(
      streamMastraToolResumeAction(
        {
          resumeData: { action: 'allow' },
          runId: 'run-approval-1',
          toolCallId: 'tool-call-1',
        },
        {
          runtime: { apiKey: 'test-key', provider: 'openai' },
          storage: storage as never,
        }
      ),
      'mastra_agent_stream_failure'
    );
  });

  it('fails visibly when the suspend-resume target is missing from the snapshot — never a blind resume', async () => {
    const storage = { id: 'workflow-storage' };
    await expectMastraAgentError(
      streamMastraToolResumeAction(
        {
          resumeData: { answer: 'Paris' },
          runId: 'run-not-in-storage',
          toolCallId: 'tool-call-not-in-storage',
        },
        {
          runtime: { apiKey: 'test-key', provider: 'openai' },
          storage: storage as never,
        }
      ),
      'mastra_agent_stream_failure'
    );
  });

  it('resumes a declined Mastra tool call through the official decline API', async () => {
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      { textDelta: 'Declined and continued.', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraToolApprovalAction(
      {
        action: 'decline',
        runId: 'run-approval-2',
        toolCallId: 'tool-call-2',
      },
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
        storage: storage as never,
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const agent = agentInstances.at(-1);
    expect(agent?.approveToolCallCalls).toHaveLength(0);
    expect(agent?.declineToolCallCalls).toHaveLength(1);
    expect(agent?.declineToolCallCalls[0]).toMatchObject({
      maxSteps: 100,
      runId: 'run-approval-2',
      toolCallId: 'tool-call-2',
    });
    // The decline resume leg preserves the same explicit global gate.
    const declineGate = (
      agent?.declineToolCallCalls[0] as { requireToolApproval?: unknown } | undefined
    )?.requireToolApproval as (ctx: { toolName: string }) => boolean;
    expect(typeof declineGate).toBe('function');
    expect(declineGate({ toolName: 'updateWorkingMemory' })).toBe(false);
    expect(declineGate({ toolName: 'shell_tool' })).toBe(true);
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'Declined and continued.' });
  });

  it('fails visibly before approval when the suspended snapshot cannot restore tool arguments', async () => {
    setSuspendedRuns([]);

    await expectMastraAgentError(
      streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: 'run-missing-snapshot',
          toolCallId: 'tool-call-missing-snapshot',
          toolName: 'workspace.writeFile',
        },
        {
          requireToolApproval: true,
          runtime: { apiKey: 'test-key', provider: 'openai' },
          storage: { id: 'workflow-storage' } as never,
        }
      ),
      'mastra_agent_stream_failure'
    );

    const agent = agentInstances.at(-1);
    expect(agent?.approveToolCallCalls).toHaveLength(0);
    expect(agent?.declineToolCallCalls).toHaveLength(0);
  });

  it('does NOT global-gate the approve resume when a policy allowed everything (empty ask set)', async () => {
    // "Allow all tools this session" grants every category, so the resume's
    // policy snapshot resolves NOTHING to 'ask' (empty askTools). That empty set
    // must read as an ALL-ALLOWED posture (a policy WAS enforced) — NOT a global
    // approval — so the resume gate gates nothing and a later mutation tool is
    // not re-prompted. Contrast the "explicit global" test above (no policy).
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      { textDelta: 'Approved with all granted.', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: 'run-approval-grant-all',
        toolCallId: 'tool-call-grant-all',
        toolName: 'workspace.writeFile',
      },
      {
        requireToolApproval: true,
        runtime: {
          apiKey: 'test-key',
          // enforce:true posture with every category granted → all-allowed.
          permissionPolicy: {
            policies: { edit: 'allow', execute: 'allow', mcp: 'allow', read: 'allow' },
            riskByTool: {},
            yolo: false,
          },
          provider: 'openai',
        },
        storage: storage as never,
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const agent = agentInstances.at(-1);
    const approveGate = (
      agent?.approveToolCallCalls[0] as { requireToolApproval?: unknown } | undefined
    )?.requireToolApproval as (ctx: { toolName: string }) => boolean;
    expect(typeof approveGate).toBe('function');
    // All-allowed posture: NOTHING is gated on the resumed leg — not the mutation
    // tool, not the internal memory tool.
    expect(approveGate({ toolName: 'brainstrike_writeWorkspaceFile' })).toBe(false);
    expect(approveGate({ toolName: 'updateWorkingMemory' })).toBe(false);
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'Approved with all granted.' });
  });

  it('validates tool approval actions before initializing Mastra runtime resources', async () => {
    await expectMastraAgentError(
      streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: ' ',
          toolCallId: 'tool-call-1',
          toolName: 'workspace.writeFile',
        },
        {
          mcpConfig: {
            servers: [
              {
                command: 'echo',
                name: 'filesystem',
                transport: 'stdio',
              },
            ],
          },
          runtime: { apiKey: 'test-key', provider: 'openai' },
          storage: { id: 'workflow-storage' } as never,
        }
      ),
      'mastra_agent_runtime_init_failed'
    );

    expect(agentInstances).toHaveLength(0);
    expect(mastraInstances).toHaveLength(0);
    expect(mcpInstances).toHaveLength(0);
  });

  it('uses the cached tool name when approval pauses omit the tool name', async () => {
    setMockStreamParts([
      {
        args: { mode: 'replace', paths: ['src/index.ts'] },
        toolCallId: 'approval-1',
        toolName: 'brainstrike.updateWorkspaceContextSelection',
        type: 'tool-call',
      },
      {
        payload: {
          args: { mode: 'replace', paths: ['src/index.ts'] },
          toolCallId: 'approval-1',
        },
        runId: 'run-approval-1',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'update selected context', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      args: { mode: 'replace', paths: ['src/index.ts'] },
      runId: 'run-approval-1',
      toolCallId: 'approval-1',
      toolName: 'brainstrike.updateWorkspaceContextSelection',
      type: 'tool-approval-required',
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({
        finishReason: 'tool-calls',
        type: 'message-finish',
      })
    );
  });

  it('surfaces a well-formed suspended tool call as a resumable tool-suspend-required pause', async () => {
    setMockStreamParts([
      {
        payload: {
          resumeSchema: '{}',
          suspendPayload: { question: 'Which city?' },
          toolCallId: 'suspended-1',
          toolName: 'brainstrike.askUser',
        },
        runId: 'run-suspended-1',
        type: 'tool-call-suspended',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'ask me something', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    // The pause is now a SUPPORTED resumable event (NOT a run.failed / error finish).
    expect(chunks).toContainEqual({
      resumeSchema: '{}',
      runId: 'run-suspended-1',
      suspendPayload: { question: 'Which city?' },
      toolCallId: 'suspended-1',
      toolName: 'brainstrike.askUser',
      type: 'tool-suspend-required',
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({ finishReason: 'tool-calls', type: 'message-finish' })
    );
    // No run.failed / error finish for a well-formed pause.
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ finishReason: 'error', type: 'message-finish' })
    );
  });

  it('keeps an OpenRouter suspending tool resumable before Mastra emits step-finish', async () => {
    setMockStreamParts([
      {
        payload: {
          suspendPayload: { question: 'Which city?' },
          toolCallId: 'suspended-cost-1',
          toolName: 'brainstrike.askUser',
        },
        runId: 'run-suspended-cost-1',
        type: 'tool-call-suspended',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-cost-suspend', parts: [{ text: 'ask me something', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openrouter' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      finishReason: 'tool-calls',
      path: [],
      type: 'message-finish',
      usage: { completionTokens: 0, promptTokens: 0 },
    });
  });

  it('keeps a malformed suspend pause (missing tool call id) a visible terminal error', async () => {
    setMockStreamParts([
      {
        payload: {
          suspendPayload: { question: 'Which city?' },
          toolName: 'brainstrike.askUser',
        },
        runId: 'run-suspended-malformed',
        type: 'tool-call-suspended',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'ask me something', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          actionRequired: true,
          missingToolCallId: true,
          suspended: true,
        }),
        status: 'error',
        type: 'tool-event',
      })
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({ finishReason: 'error', type: 'message-finish' })
    );
  });

  // REGRESSION GUARD: the real Mastra stream part carries the REGISTERED
  // (sanitized) id — see mastra-tool-suspend-resume.integration.spec.ts:219,344 —
  // and `sanitizedNameMap` is optional (spread conditionally at every call site),
  // so a missing map must never decide whether a pause is resumable.
  it.each([
    ['brainstrike_askUser', 'brainstrike.askUser', { question: 'Which city?' }],
    [
      'brainstrike_submitPlan',
      'brainstrike.submitPlan',
      { overview: 'do it', steps: [{ title: 'step' }], title: 'Plan' },
    ],
  ])('treats a %s suspend part with NO sanitizedNameMap as REGISTERED and resumable', async (sanitizedToolName, dottedToolName, suspendPayload) => {
    setMockStreamParts([
      {
        payload: {
          suspendPayload,
          toolCallId: 'suspended-sanitized-1',
          toolName: sanitizedToolName,
        },
        runId: 'run-suspended-sanitized-1',
        type: 'tool-call-suspended',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-sanitized', parts: [{ text: 'go', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    // The pause is offered for resume, under the CLIENT-FACING dotted id.
    expect(chunks).toContainEqual({
      runId: 'run-suspended-sanitized-1',
      suspendPayload,
      toolCallId: 'suspended-sanitized-1',
      toolName: dottedToolName,
      type: 'tool-suspend-required',
    });
    // ...and it is NOT treated as an unregistered dead end: no rejection event,
    // and no `resumeSupported: false` (which would settle the tool card that is
    // legitimately waiting for the user's answer).
    expect(findRunEventChunks(chunks, 'tool.resume.unsupported')).toHaveLength(0);
    expect(findRunEventChunks(chunks, 'tool.failed')).toHaveLength(0);
    expect(chunks).toContainEqual(
      expect.objectContaining({ finishReason: 'tool-calls', type: 'message-finish' })
    );
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ finishReason: 'error', type: 'message-finish' })
    );
  });

  it('records a VISIBLE, NON-TERMINAL rejection for an UNREGISTERED suspending tool', async () => {
    setMockStreamParts([
      {
        payload: {
          resumeSchema: '{"type":"object"}',
          suspendPayload: { secretish: 'raw payload body' },
          toolCallId: 'suspended-unregistered-1',
          toolName: 'brainstrike.someFutureSuspendingTool',
        },
        runId: 'run-suspended-unregistered-1',
        type: 'tool-call-suspended',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-unregistered', parts: [{ text: 'do the thing', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    // Durable, visible rejection: this build cannot answer the pause. Its own
    // KIND, never `tool.failed` — the ledger counts `tool.completed`/`tool.failed`
    // as tool calls AND failures, and a later build resuming this very pause
    // emits the real `tool.completed` for the same toolCallId.
    expect(findRunEventChunks(chunks, 'tool.failed')).toHaveLength(0);
    const rejections = findRunEventChunks(chunks, 'tool.resume.unsupported');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.event.status).toBe('failed');
    expect(rejections[0]?.event.metadata).toMatchObject({
      resumeSupportedByClient: false,
      runId: 'run-suspended-unregistered-1',
      runStillSuspended: true,
      suspended: true,
      toolCallId: 'suspended-unregistered-1',
      toolName: 'brainstrike.someFutureSuspendingTool',
      unregisteredResumeSchema: true,
    });
    // The raw tool-defined suspend payload must NEVER reach durable metadata.
    expect(rejections[0]?.event.metadata).not.toHaveProperty('suspendPayload');
    expect(JSON.stringify(rejections[0]?.event.metadata)).not.toContain('raw payload body');
    // NOT terminal: Mastra already persisted the suspended snapshot, so claiming
    // the run was stopped would be false. No run.failed, no error finish.
    expect(findRunEventChunks(chunks, 'run.failed')).toHaveLength(0);
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ finishReason: 'error', type: 'message-finish' })
    );
    // The pause still reaches the renderer so the notice can explain it, and it
    // carries `resumeSupported: false` so the mapper SETTLES the tool card
    // instead of leaving a permanently Running one behind a dismissed notice.
    expect(chunks).toContainEqual({
      resumeSchema: '{"type":"object"}',
      resumeSupported: false,
      runId: 'run-suspended-unregistered-1',
      suspendPayload: { secretish: 'raw payload body' },
      toolCallId: 'suspended-unregistered-1',
      toolName: 'brainstrike.someFutureSuspendingTool',
      type: 'tool-suspend-required',
    });
  });

  it.each([
    ['brainstrike.askUser', { question: 'Which city?' }],
    ['brainstrike.submitPlan', { overview: 'do it', steps: [{ title: 'step' }], title: 'Plan' }],
  ])('keeps the REGISTERED suspending tool %s resumable and unaffected by the rejection path', async (toolName, suspendPayload) => {
    setMockStreamParts([
      {
        payload: {
          suspendPayload,
          toolCallId: 'suspended-registered-1',
          toolName,
        },
        runId: 'run-suspended-registered-1',
        type: 'tool-call-suspended',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-registered', parts: [{ text: 'go', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      runId: 'run-suspended-registered-1',
      suspendPayload,
      toolCallId: 'suspended-registered-1',
      toolName,
      type: 'tool-suspend-required',
    });
    expect(findRunEventChunks(chunks, 'tool.resume.unsupported')).toHaveLength(0);
    expect(findRunEventChunks(chunks, 'tool.failed')).toHaveLength(0);
    expect(chunks).toContainEqual(
      expect.objectContaining({ finishReason: 'tool-calls', type: 'message-finish' })
    );
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ finishReason: 'error', type: 'message-finish' })
    );
  });

  it('keeps malformed approval pauses visible when Mastra omits the tool call id', async () => {
    setMockStreamParts([
      {
        payload: {
          args: { mode: 'replace', paths: ['src/index.ts'] },
          toolName: 'brainstrike.updateWorkspaceContextSelection',
        },
        runId: 'run-approval-without-tool-call-id',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'update selected context', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      expect.objectContaining({
        name: 'brainstrike.updateWorkspaceContextSelection',
        payload: expect.objectContaining({
          callId: 'mastra-tool-call-approval-missing-tool-call-id',
          missingToolCallId: true,
          toolCallId: 'mastra-tool-call-approval-missing-tool-call-id',
        }),
        status: 'error',
        type: 'tool-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'run.failed',
          metadata: expect.objectContaining({
            missingToolCallId: true,
            toolCallId: 'mastra-tool-call-approval-missing-tool-call-id',
          }),
        }),
        type: 'run-event',
      }),
      {
        finishReason: 'error',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });
});

describe('run_python approval executionContext stamping (BST-1070)', () => {
  beforeEach(() => {
    resetMastraStreamHarness();
  });

  async function collectApprovalChunk(args: unknown, toolName = 'brainstrike.runPython') {
    setMockStreamParts([
      {
        payload: { args, toolCallId: 'approval-run-python-1', toolName },
        runId: 'run-approval-run-python-1',
        type: 'tool-call-approval',
      },
    ]);
    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'run some python', type: 'text' }], role: 'user' }],
      { requireToolApproval: true, runtime: { apiKey: 'test-key', provider: 'openai' } }
    );
    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }
    return expectLeadingContextBreakdown(chunks).find(
      (chunk) =>
        typeof chunk === 'object' &&
        chunk !== null &&
        (chunk as { type?: unknown }).type === 'tool-approval-required'
    ) as Record<string, unknown> | undefined;
  }

  it('stamps a server-computed executionContext for a well-formed run_python approval', async () => {
    const approval = await collectApprovalChunk({ code: 'print(1)', timeoutMs: 60_000 });
    expect(approval).toBeDefined();
    expect(approval?.['executionContext']).toMatchObject({
      allowedDomains: [],
      defaultReadAccess: 'permissive',
      executorKind: 'fence',
      language: 'python',
      timeoutMs: 60_000,
    });
    expect(
      typeof (approval?.['executionContext'] as { policyFingerprint?: unknown })?.policyFingerprint
    ).toBe('string');
  });

  it('omits executionContext when the args do not parse — the card falls to its fail-safe path', async () => {
    const approval = await collectApprovalChunk({
      code: 'print(1)',
      unknownField: true,
    });
    expect(approval).toBeDefined();
    expect(approval && 'executionContext' in approval).toBe(false);
  });

  it('never stamps executionContext on a non-code-execution tool', async () => {
    const approval = await collectApprovalChunk(
      { command: 'echo hi' },
      'brainstrike.executeCommand'
    );
    expect(approval).toBeDefined();
    expect(approval && 'executionContext' in approval).toBe(false);
  });
});

describe('listSuspendedMastraRuns classification (BST-1084)', () => {
  beforeEach(() => {
    resetMastraStreamHarness();
  });

  it('classifies a mixed run: approval-gated calls to approvals, suspend() pauses to suspends, id-less skipped', async () => {
    setSuspendedRuns([
      {
        runId: 'run-mixed-1',
        status: 'suspended',
        suspendedAt: new Date('2026-08-01T00:00:00Z'),
        toolCalls: [
          {
            args: { command: 'echo hi' },
            requiresApproval: true,
            toolCallId: 'call-approval-1',
            toolName: 'brainstrike_executeCommand',
          },
          {
            requiresApproval: false,
            suspendPayload: { question: 'Which region?' },
            toolCallId: 'call-suspend-1',
            toolName: 'brainstrike_askUser',
          },
          {
            // A delegation-thread style entry without ids: tolerated + skipped.
            requiresApproval: false,
            toolCallId: '',
            toolName: '',
          },
        ],
      },
    ]);

    const result = await listSuspendedMastraRuns(
      { resourceId: 'workspace-a', threadId: 'thread-1' },
      { runtime: { apiKey: 'test-key', provider: 'openai' }, storage: {} as never }
    );

    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({
      toolCallId: 'call-approval-1',
      toolName: 'brainstrike.executeCommand',
    });
    expect(result.suspends).toHaveLength(1);
    expect(result.suspends[0]).toMatchObject({
      suspendPayload: { question: 'Which region?' },
      toolCallId: 'call-suspend-1',
      toolName: 'brainstrike.askUser',
    });
  });

  it('CANARY: a call listed as both approval and suspend yields ONE approval card, never two cards', async () => {
    setSuspendedRuns([
      {
        runId: 'run-dup-1',
        status: 'suspended',
        suspendedAt: new Date('2026-08-01T00:00:00Z'),
        toolCalls: [
          {
            args: { code: 'print(1)' },
            requiresApproval: true,
            toolCallId: 'call-dup-1',
            toolName: 'brainstrike_runPython',
          },
          {
            requiresApproval: false,
            suspendPayload: { allowedDomains: ['pypi.org'], kind: 'network' },
            toolCallId: 'call-dup-1',
            toolName: 'brainstrike_runPython',
          },
        ],
      },
    ]);

    const result = await listSuspendedMastraRuns(
      { resourceId: 'workspace-a', threadId: 'thread-1' },
      { runtime: { apiKey: 'test-key', provider: 'openai' }, storage: {} as never }
    );

    expect(result.approvals).toHaveLength(1);
    expect(result.suspends).toHaveLength(0);
  });
});
