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
  streamMastraAgent,
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
} from '../mastra/agent-streaming';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import { TOOL_CALL_DECLINED_MESSAGE } from '../mastra/tool-event-mapper';
import { DataStreamCode } from '../stream/data-stream-codes';
import { DataStreamMapper } from '../stream/data-stream-mapper';
import type { StreamChunk } from '../types';
import {
  agentInstances,
  expectLeadingContextBreakdown,
  expectMastraAgentError,
  findRunEventChunks,
  mastraInstances,
  mcpHost,
  mcpInstances,
  resetMastraStreamHarness,
  setMockStreamParts,
  setStreamCompletion,
  setStreamPartFailure,
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

  it('fails before exposing a decision when native snapshot completion rejects', async () => {
    const failure = new Error('Native snapshot write failed');
    const completion = vi.fn(async () => {
      throw failure;
    });
    setStreamCompletion(completion);
    setMockStreamParts([
      {
        payload: {
          args: { path: 'file.txt' },
          toolCallId: 'unsaved-approval',
          toolName: 'brainstrike.writeWorkspaceFile',
        },
        runId: 'unsaved-run',
        type: 'tool-call-approval',
      },
    ]);
    const stream = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'Write the file', type: 'text' }], role: 'user' }],
      { requireToolApproval: true, runtime: { apiKey: 'test-key', provider: 'openai' } }
    );
    const chunks: StreamChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
      })()
    ).rejects.toThrow('Native snapshot write failed');
    expect(completion).toHaveBeenCalledTimes(1);
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-required')).toBe(false);
  });

  it('drops a withheld pause notice when the user stops the run before native close', async () => {
    // A parallel delegation step keeps streaming after one sibling pauses, so
    // the leg reads to native close and withholds the notice until then. A
    // Stop in that window cancels paused work: the decision is unresumable and
    // neither its notice nor its durable "awaiting your approval" row may
    // surface (Codex review of #3187).
    const controller = new AbortController();
    setMockStreamParts([
      {
        payload: {
          args: { path: 'file.txt' },
          toolCallId: 'stopped-approval',
          toolName: 'brainstrike.writeWorkspaceFile',
        },
        runId: 'stopped-run',
        type: 'tool-call-approval',
      },
      { textDelta: 'a sibling still streaming', type: 'text-delta' },
    ]);
    const stream = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'Write the file', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai', signal: controller.signal },
      }
    );
    const chunks: StreamChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      if (chunk.type === 'text-delta') {
        // The pause part has been read and withheld; the sibling's text proves
        // the leg is still open. Stop now, before native close.
        controller.abort();
      }
    }
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-required')).toBe(false);
    expect(
      chunks.some(
        (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'tool.approval.requested'
      )
    ).toBe(false);
  });

  it('publishes a withheld pause notice when a later sibling fails the leg', async () => {
    // The pause already reached Mastra and is parked durably; a failure
    // elsewhere in the same leg must not hide it behind reload rediscovery.
    // Only a rejected completion join (previous case) or a Stop discards it.
    const failure = new Error('sibling projection failed');
    setStreamPartFailure(1, failure);
    setMockStreamParts([
      {
        payload: {
          args: { path: 'file.txt' },
          toolCallId: 'orphaned-approval',
          toolName: 'brainstrike.writeWorkspaceFile',
        },
        runId: 'orphaned-run',
        type: 'tool-call-approval',
      },
      { textDelta: 'never delivered', type: 'text-delta' },
    ]);
    const stream = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'Write the file', type: 'text' }], role: 'user' }],
      { requireToolApproval: true, runtime: { apiKey: 'test-key', provider: 'openai' } }
    );
    const chunks: StreamChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
      })()
    ).rejects.toThrow('sibling projection failed');
    expect(
      chunks.filter((chunk) => chunk.type === 'tool-approval-required').map((c) => c.toolCallId)
    ).toEqual(['orphaned-approval']);
    expect(
      chunks.some(
        (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'tool.approval.requested'
      )
    ).toBe(true);
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
    // The initial leg passes the caller's explicit option through unchanged;
    // no run-wide predicate is ever synthesized (per-call approval rides on
    // the per-tool function-form flag, approval-gate.ts).
    expect(streamOptions.requireToolApproval).toBe(true);
    // The durable run event leads the pause (see the dedicated ordering test
    // below); the transient chunks it precedes are pinned EXACTLY here.
    const [durableRunEvent, ...transientChunks] = expectLeadingContextBreakdown(chunks);
    expect(durableRunEvent).toMatchObject({
      event: { kind: 'tool.approval.requested' },
      type: 'run-event',
    });
    expect(transientChunks).toEqual([
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

  it('emits a durable tool.approval.requested run event BEFORE the approval-required chunk', async () => {
    // BST-1402: the approval PAUSE is durable. It does not replace the
    // `tool-approval-required` transient — a reload rebuilds the actionable
    // notice from the Mastra suspended snapshot — but that rediscovery is a
    // per-thread round trip that only sees STILL-PENDING pauses. The run event
    // is persisted by `observeDesktopAssistantRunEvents` and is the cheap
    // cross-thread row the Threads panel's "needs you" projection queries, and
    // the only record that outlives the pause being answered.
    setMockStreamParts([
      {
        payload: {
          args: { mode: 'replace', paths: ['src/index.ts'] },
          resumeSchema: '{}',
          toolCallId: 'approval-durable-1',
          toolName: 'brainstrike.updateWorkspaceContextSelection',
        },
        runId: 'run-approval-durable-1',
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

    const [first, second] = expectLeadingContextBreakdown(chunks);
    // ORDER is the contract: the durable row must exist even if the consumer
    // tears the stream down the instant it sees the pause chunk.
    expect(first).toMatchObject({
      event: {
        kind: 'tool.approval.requested',
        label: 'Awaiting your approval',
        metadata: {
          toolCallId: 'approval-durable-1',
          toolName: 'brainstrike.updateWorkspaceContextSelection',
        },
        status: 'running',
      },
      type: 'run-event',
    });
    // No `riskCategory` is invented when the pause was not policy-driven.
    expect(
      (first as { event: { metadata: Record<string, unknown> } }).event.metadata
    ).not.toHaveProperty('riskCategory');
    expect(second).toMatchObject({ type: 'tool-approval-required' });
    expect(chunks.at(-1)).toMatchObject({ finishReason: 'tool-calls', type: 'message-finish' });
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
      expect.objectContaining({
        // The durable row carries the SAME denormalized name the notice shows.
        event: expect.objectContaining({
          kind: 'tool.approval.requested',
          metadata: expect.objectContaining({
            toolCallId: 'approval-denormalize-1',
            toolName: 'brainstrike.executeCommand',
          }),
        }),
        type: 'run-event',
      }),
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
    // BST-1402: the durable row carries the resolved risk too, so the
    // cross-thread projection can say WHY a run stopped and asked without
    // reopening that thread's suspended snapshot.
    expect(findRunEventChunks(chunks, 'tool.approval.requested')).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          label: 'Awaiting your approval',
          metadata: {
            riskCategory: 'execute',
            toolCallId: 'approval-dotted-1',
            toolName: 'brainstrike.runShell',
          },
          status: 'running',
        }),
      }),
    ]);
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
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool.approval.requested',
          metadata: expect.objectContaining({ toolCallId: 'approval-1' }),
          status: 'running',
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
    const memory = {
      getMergedThreadConfig: (config?: object) => config ?? {},
      id: 'memory-instance',
    };
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

  // BST-1232 review (P2): the approval-resume leg used to omit
  // `promptBreakdown` entirely, so a resumed run's calibration row always
  // persisted a NULL `prompt_baseline_tokens` — even though prompt
  // composition (instructions + tool definitions) is unchanged across a
  // resume and the SAME baseline the initial turn would have reported still
  // applies. Most non-trivial agentic threads pause at least once, so this
  // meant most threads' NEWEST calibration row was NULL-baseline, starving
  // the next turn's compaction trigger.
  it('persists a baseline-carrying calibration row on an approval-resume leg', async () => {
    setMockStreamParts([
      { type: 'step-finish', usage: { completionTokens: 3, promptTokens: 42 } },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 3, promptTokens: 42 } },
    ]);

    // Reuses the harness's default suspended-run fixture entry
    // (run-approval-1 / tool-call-1, see mastra-stream-harness.ts) — same
    // ids the passing 'resumes an approved Mastra tool call...' test above
    // uses, since `resetMastraStreamHarness()` reseeds it before every test.
    const iterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: 'run-approval-1',
        toolCallId: 'tool-call-1',
        toolName: 'workspace.writeFile',
      },
      {
        mcpHost,
        requireToolApproval: true,
        runtime: {
          apiKey: 'test-key',
          model: 'gpt-5.6-terra',
          provider: 'openai',
        },
        storage: { id: 'workflow-storage' } as never,
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const calibration = chunks.find(
      (chunk): chunk is { type: 'token-estimate-calibration'; value: Record<string, unknown> } =>
        Boolean(
          chunk &&
            typeof chunk === 'object' &&
            (chunk as { type?: unknown }).type === 'token-estimate-calibration'
        )
    );
    expect(calibration).toBeDefined();
    expect(calibration?.value['promptBreakdownBaselineTokens']).toEqual(expect.any(Number));
    expect((calibration?.value['promptBreakdownBaselineTokens'] as number) > 0).toBe(true);
    // A resume sends no new messages — the context-breakdown chunk this same
    // promptBreakdown feeds should reflect that honestly (zero attachments).
    const breakdown = chunks.find(
      (chunk): chunk is { breakdown: Record<string, unknown>; type: 'context-breakdown' } =>
        Boolean(
          chunk &&
            typeof chunk === 'object' &&
            (chunk as { type?: unknown }).type === 'context-breakdown'
        )
    )?.breakdown;
    expect(breakdown?.['attachmentsCount']).toBe(0);
    expect(mcpInstances).toEqual([
      expect.objectContaining({ closeCalls: 1 }),
      expect.objectContaining({ closeCalls: 1 }),
    ]);
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

  // BST-1232 review (P2): same rationale as the approval-resume calibration
  // test above — the suspended-tool resume leg (askUser/submitPlan resumes)
  // also used to omit `promptBreakdown`, so its calibration row always
  // persisted a NULL baseline too.
  it('persists a baseline-carrying calibration row on a suspended-tool resume leg', async () => {
    setSuspendedRuns([
      {
        runId: 'run-suspended-calibration',
        status: 'suspended',
        suspendedAt: new Date('2026-07-21T00:00:00Z'),
        toolCalls: [
          {
            args: {},
            requiresApproval: false,
            suspendPayload: { question: 'Which city?' },
            toolCallId: 'tool-call-suspended-calibration',
            toolName: 'brainstrike_askUser',
          },
        ],
      },
    ]);
    setMockStreamParts([
      { type: 'step-finish', usage: { completionTokens: 2, promptTokens: 33 } },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 33 } },
    ]);

    const iterator = await streamMastraToolResumeAction(
      {
        resumeData: { answer: 'Paris' },
        runId: 'run-suspended-calibration',
        toolCallId: 'tool-call-suspended-calibration',
      },
      {
        runtime: {
          apiKey: 'test-key',
          model: 'gpt-5.6-terra',
          provider: 'openai',
        },
        storage: { id: 'workflow-storage' } as never,
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const calibration = chunks.find(
      (chunk): chunk is { type: 'token-estimate-calibration'; value: Record<string, unknown> } =>
        Boolean(
          chunk &&
            typeof chunk === 'object' &&
            (chunk as { type?: unknown }).type === 'token-estimate-calibration'
        )
    );
    expect(calibration).toBeDefined();
    expect((calibration?.value['promptBreakdownBaselineTokens'] as number) > 0).toBe(true);
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

  it("attaches the rider to an ask-gated askUser's {answer} ENVELOPE resume — the shape the notice sends", async () => {
    // The envelope migration exists exactly for this: askUser's canonical
    // resume is now a plain object, so gating the 'read' category (or askUser
    // per-tool) to 'ask' no longer strands its answers behind Mastra's
    // per-leg re-check denial.
    const storage = { id: 'workflow-storage' };
    setSuspendedRuns([
      {
        runId: 'run-rider-4',
        status: 'suspended',
        suspendedAt: new Date('2026-08-07T00:00:00Z'),
        toolCalls: [
          {
            args: {},
            requiresApproval: false,
            suspendPayload: { question: 'Proceed?' },
            toolCallId: 'tool-call-rider-4',
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
        resumeData: { answer: 'yes, proceed' },
        runId: 'run-rider-4',
        toolCallId: 'tool-call-rider-4',
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

    expect(agentInstances.at(-1)?.resumeStreamCalls[0]?.resumeData).toEqual({
      answer: 'yes, proceed',
      approved: true,
    });
  });

  it('LEGACY compat: passes a NON-OBJECT resume payload through untouched even for an ask-gated tool — never mangled into an index map', async () => {
    // The bare string/array is the PRE-ENVELOPE askUser answer shape, still
    // possible when resuming a run suspended before the {answer} envelope
    // migration. Spreading it would corrupt it: the rider is skipped (loud
    // warn at the transport), and the payload reaches Mastra byte-identical.
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

  it('settles the declined tool call from the 1.59 tool-output-denied chunk instead of leaving it pending', async () => {
    // BST-1282. `@mastra/core` 1.59 added `tool-output-denied` (mastra #20886)
    // precisely so a declined `requireApproval` call RESOLVES: the tool never
    // runs and no later `tool-result`/`tool-error` carries this id, so treating
    // the chunk as `'ignored'` would strand the renderer's tool part pending
    // forever. Proven across BOTH R6 stages — the Mastra→StreamChunk mapping
    // here, and the StreamChunk→frame mapping that actually settles the call.
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      {
        payload: {
          approval: { approved: false, id: 'approval-decline-1', reason: 'not this path' },
          args: { command: 'echo declined' },
          toolCallId: 'tool-call-2',
          toolName: 'shell_tool',
        },
        type: 'tool-output-denied',
      },
      { textDelta: 'Understood, skipping that.', type: 'text-delta' },
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

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk as StreamChunk);
    }

    // Stage 1 — the Mastra boundary maps it to the TERMINAL decline tool event,
    // carrying the shared `DeclinedToolCallResult` envelope (with the user's
    // own reason) rather than an error string.
    expect(chunks).toContainEqual({
      name: 'shell_tool',
      payload: {
        args: { command: 'echo declined' },
        callId: 'tool-call-2',
        result: {
          kind: 'declined',
          message: TOOL_CALL_DECLINED_MESSAGE,
          reason: 'not this path',
        },
        toolCallId: 'tool-call-2',
      },
      status: 'declined',
      type: 'tool-event',
    });
    // …and closes the durable timeline row out, relabelled as a decline.
    const failedEvents = findRunEventChunks(chunks, 'tool.failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.event).toMatchObject({
      label: 'Tool call declined',
      metadata: { toolCallId: 'tool-call-2', toolName: 'shell_tool' },
      status: 'failed',
    });

    // Stage 2 — the call SETTLES on the wire: a `toolCallResult` frame for this
    // id, which is what stops the renderer's part spinning. Its absence is
    // exactly the hang this chunk exists to fix. NOT flagged `isError`: that is
    // the destructive-chrome switch, and the declined envelope is what the card
    // reads to pick its muted stopped treatment.
    const mapper = new DataStreamMapper('message-declined');
    const frames = chunks.flatMap((chunk) => [...mapper.handleChunk(chunk)]);
    expect(frames).toContainEqual({
      code: DataStreamCode.toolCallResult,
      value: {
        result: {
          kind: 'declined',
          message: TOOL_CALL_DECLINED_MESSAGE,
          reason: 'not this path',
        },
        toolCallId: 'tool-call-2',
      },
    });
  });

  it('does NOT report a declined tool call as a failure when the denial is the last chunk before finish', async () => {
    // BST-1282 review. `pendingToolErrorTexts` is cleared only by a later
    // `text-delta`, so routing the decline through the ERROR path made an empty
    // continuation (or a Stop right after the denial) emit "I couldn't complete
    // the tool action because it failed: The user declined this tool call…" and
    // finalize the step as errored. Nothing failed — the user chose. This is the
    // fixture the first test deliberately does not cover: no text after the
    // denial, so nothing clears the map.
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      {
        payload: {
          approval: { approved: false, id: 'approval-decline-2' },
          args: { command: 'echo declined' },
          toolCallId: 'tool-call-2',
          toolName: 'shell_tool',
        },
        type: 'tool-output-denied',
      },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 0, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraToolApprovalAction(
      { action: 'decline', runId: 'run-approval-2', toolCallId: 'tool-call-2' },
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
        storage: storage as never,
      }
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk as StreamChunk);
    }

    // No reason given → the envelope carries the decision alone.
    expect(chunks).toContainEqual({
      name: 'shell_tool',
      payload: {
        args: { command: 'echo declined' },
        callId: 'tool-call-2',
        result: { kind: 'declined', message: TOOL_CALL_DECLINED_MESSAGE },
        toolCallId: 'tool-call-2',
      },
      status: 'declined',
      type: 'tool-event',
    });

    const mapper = new DataStreamMapper('message-declined-silent');
    const frames = chunks.flatMap((chunk) => [...mapper.handleChunk(chunk)]);
    frames.push(...mapper.finalizeOnStreamEnd());

    // The call still settles…
    expect(frames).toContainEqual({
      code: DataStreamCode.toolCallResult,
      value: {
        result: { kind: 'declined', message: TOOL_CALL_DECLINED_MESSAGE },
        toolCallId: 'tool-call-2',
      },
    });
    // …and NOTHING claims a failure: no visible fallback text, no error frame,
    // and the message finishes normally instead of as an errored step.
    const visibleText = frames
      .filter((frame) => frame.code === DataStreamCode.textDelta)
      .map((frame) => String(frame.value))
      .join('');
    expect(visibleText).not.toContain('failed');
    expect(frames.some((frame) => frame.code === DataStreamCode.error)).toBe(false);
    expect(mapper.getTerminalOutcome()).toEqual({ error: null, status: 'completed' });
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
  ])(
    'treats a %s suspend part with NO sanitizedNameMap as REGISTERED and resumable',
    async (sanitizedToolName, dottedToolName, suspendPayload) => {
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
    }
  );

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
  ])(
    'keeps the REGISTERED suspending tool %s resumable and unaffected by the rejection path',
    async (toolName, suspendPayload) => {
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
    }
  );

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
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
        storage: { id: 'sibling-storage' } as never,
      }
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

describe('resume-leg sibling tool visibility', () => {
  // Field failure (2026-08-24): Mastra resume legs never replay the suspended
  // step's tool-call parts, and the synthetic start covered ONLY the approved
  // call — so a sibling delegation in the same step ran for four minutes with
  // NO card and no subagent.started, and the UI pinned the whole wait on the
  // stale approved-tool card. Every pending call of the suspended run must get
  // its start back; agent-* siblings also get their subagent.started so the
  // delegation card exists and later subagent terminals have a mate.
  it('synthesizes starts for the approved call AND its siblings, with subagent.started for delegations', async () => {
    setSuspendedRuns([
      {
        runId: 'run-sibling-1',
        status: 'suspended',
        suspendedAt: new Date('2026-08-24T00:00:00Z'),
        toolCalls: [
          {
            args: { path: 'scripts/context.mjs' },
            requiresApproval: true,
            toolCallId: 'call-approved',
            toolName: 'run_skill_script',
          },
          {
            args: { prompt: 'survey the repo' },
            requiresApproval: false,
            toolCallId: 'call-sibling-delegation',
            toolName: 'agent-explore',
          },
        ],
      },
    ]);
    setMockStreamParts([
      { textDelta: 'resumed answer', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 5 } },
    ]);

    const iterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: 'run-sibling-1',
        toolCallId: 'call-approved',
        toolName: 'run_skill_script',
      },
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
        storage: { id: 'sibling-workflow-storage' } as never,
      }
    );
    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const startEvents = chunks.filter(
      (chunk) =>
        (chunk as { type?: string; status?: string }).type === 'tool-event' &&
        (chunk as { status?: string }).status === 'start'
    ) as { payload?: { toolCallId?: string } }[];
    const startIds = startEvents.map((event) => event.payload?.toolCallId);
    expect(startIds).toContain('call-approved');
    expect(startIds).toContain('call-sibling-delegation');

    const subagentStarted = findRunEventChunks(chunks, 'subagent.started');
    expect(subagentStarted).toHaveLength(1);
    expect(subagentStarted[0]?.event.metadata).toMatchObject({
      parentToolCallId: 'call-sibling-delegation',
      personaId: 'explore',
    });

    // BST-1440: the synthetic starts now also produce DURABLE `tool.started`
    // run events — that is what clears the Threads panel's "needs you" signal
    // on ANSWER rather than on completion. Siblings get one too, deliberately:
    // a call pending in the same suspended step is genuinely in flight, which
    // is why it gets a start chunk at all.
    //
    // SAFE only because a leg writes at most ONE `tool.approval.requested`:
    // the stream stops at the first `tool-call-approval` part, so a sibling's
    // own pause row can only be written on a LATER leg than this start — and
    // `THREADS_AWAITING_APPROVAL_SQL` requires an answer to POSTDATE its pause,
    // so this start cannot resolve it. COUPLING, for whoever changes that: if
    // the stream ever surfaces every pending pause on one leg, a still-gated
    // sibling's pause would predate this start and be cleared by it — the glyph
    // would go dark on an approval nobody answered. Emitting starts for
    // still-gated siblings has to stop at the same time.
    const toolStarted = findRunEventChunks(chunks, 'tool.started');
    const startedIds = toolStarted.map((chunk) => chunk.event.metadata?.['toolCallId']);
    expect(startedIds).toContain('call-approved');
    expect(startedIds).toContain('call-sibling-delegation');
  });
});
