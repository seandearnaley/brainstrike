import { expect, it } from 'vitest';
import { processMastraStreamPart } from '../mastra/agent-streaming';
import { createDelegatedStreamProjection } from '../mastra/delegated-stream-projection';
import { MCP_PROGRESS_STREAM_PART_TYPE } from '../mastra/mcp-runtime-client';
import { makeDelegatedStreamTermination } from '../mastra/stream-termination';
import { createTurnAttemptLifecycleState } from '../mastra/turn-attempts';

it.each(['shell', 'mcp'] as const)(
  'keeps queued %s output from a stopped child from failing its running sibling',
  async (kind) => {
    const controllers = new Map<string, AbortController>();
    const projection = createDelegatedStreamProjection({
      authorize: async (identity) => ({
        messageId: `message-${identity.parentToolCallId}`,
        threadId: `thread-${identity.parentToolCallId}`,
      }),
      createState: (_personaId, _threadId, identity) => {
        const controller = new AbortController();
        controllers.set(identity.parentToolCallId, controller);
        return {
          controller,
          lifecycle: createTurnAttemptLifecycleState(undefined, undefined, undefined),
        };
      },
      isActiveToolCall: (state, toolCallId) =>
        state.lifecycle.activeToolEvents?.has(toolCallId) === true &&
        !state.lifecycle.terminalToolCallStates.has(toolCallId),
      mapPart: async (part, state, toolNames) => {
        const result = state.controller.signal.aborted
          ? { chunks: makeDelegatedStreamTermination(state.lifecycle, true), finished: true }
          : await processMastraStreamPart(part, toolNames, state.lifecycle);
        return {
          chunks: result.chunks.map((chunk) => {
            if (
              chunk.type === 'delegated-conversation-chunk' ||
              chunk.type === 'child-continuation-chunk'
            ) {
              throw new Error('A native child mapper emitted an already-scoped chunk.');
            }
            return chunk;
          }),
          finished: result.finished,
        };
      },
      personas: new Map([['agent-explore', 'explore']]),
    });
    if (!projection) {
      throw new Error('Missing delegated projection.');
    }

    const wrap = (parentToolCallId: string, output: unknown) => ({
      payload: { output, toolCallId: parentToolCallId, toolName: 'agent-explore' },
      runId: 'root-run',
      type: 'tool-output',
    });
    const start = (parentToolCallId: string, toolCallId: string) =>
      wrap(parentToolCallId, {
        args: { command: 'printf output' },
        runId: `child-run-${parentToolCallId}`,
        toolCallId,
        toolName: 'brainstrike_executeCommand',
        type: 'tool-call',
      });
    const output = (parentToolCallId: string, toolCallId: string, chunk: string) =>
      wrap(
        parentToolCallId,
        kind === 'shell'
          ? { chunk, stream: 'stdout', toolCallId, type: 'brainstrike.shell-output.chunk' }
          : {
              progress: 1,
              toolCallId,
              toolName: 'mcp.synthetic',
              type: MCP_PROGRESS_STREAM_PART_TYPE,
            }
      );

    await projection.project(start('selected', 'selected-tool'), new Map());
    await projection.project(start('sibling', 'sibling-tool'), new Map());
    controllers.get('selected')?.abort(new Error('Stop selected child'));

    const firstQueued = await projection.project(
      output('selected', 'selected-tool', 'queued before Stop 1'),
      new Map()
    );
    expect(firstQueued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunk: expect.objectContaining({
            event: expect.objectContaining({ kind: 'run.cancelled' }),
            type: 'run-event',
          }),
        }),
      ])
    );
    expect(
      await projection.project(
        output('selected', 'selected-tool', 'queued before Stop 2'),
        new Map()
      )
    ).toEqual([]);
    expect(
      await projection.project(output('sibling', 'sibling-tool', 'still running'), new Map())
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunk: expect.objectContaining(
            kind === 'shell'
              ? { chunk: 'still running', type: 'shell-output' }
              : { status: 'progress', type: 'tool-event' }
          ),
          identity: expect.objectContaining({ parentToolCallId: 'sibling' }),
        }),
      ])
    );
  }
);
