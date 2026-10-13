import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ModelProviderRequest,
  type ModelProviderShim,
  startModelProviderShim,
} from './model-provider-shim';

export const assembledMarkers = {
  parentPrompt: 'ASSEMBLED_ROOT_FANOUT_1770',
  parentResult: 'ASSEMBLED_ROOT_COMPLETE_1770',
  parkedApproved: 'PARKED_APPROVED_COMPLETE_1770',
  streamA: 'STREAM_ALPHA_COMPLETE_1770',
  streamB: 'STREAM_BETA_COMPLETE_1770',
} as const;

export interface AssembledSubagentFixture {
  readonly environment: Readonly<Record<string, string>>;
  readonly provider: ModelProviderShim;
  readonly releaseAlpha: () => void;
  readonly releaseBeta: () => void;
  /** Lets the root dispatch the two streams; call once both parked children asked to read. */
  readonly releaseStreams: () => void;
  readonly requests: () => readonly ModelProviderRequest[];
}

function userHistory(request: ModelProviderRequest): string {
  return JSON.stringify(
    request.messages
      .filter(
        (message) =>
          message && typeof message === 'object' && 'role' in message && message.role === 'user'
      )
      .at(-1)
  );
}

function hasAssistantToolCall(request: ModelProviderRequest, name: string): boolean {
  return request.messages.some((message) => {
    if (
      !(message && typeof message === 'object' && 'role' in message && message.role === 'assistant')
    ) {
      return false;
    }
    const calls = 'tool_calls' in message ? message.tool_calls : undefined;
    return (
      Array.isArray(calls) &&
      calls.some(
        (call) =>
          call &&
          typeof call === 'object' &&
          'function' in call &&
          call.function &&
          typeof call.function === 'object' &&
          'name' in call.function &&
          call.function.name === name
      )
    );
  });
}

export async function createAssembledSubagentFixture(
  workspace: string
): Promise<AssembledSubagentFixture> {
  const agents = path.join(workspace, '.brainstrike', 'agents');
  await mkdir(agents, { recursive: true });
  const personas = [
    [
      'stream-alpha',
      'Stream Alpha',
      'Read evidence.txt, then report completion.',
      'readWorkspaceFile',
    ],
    [
      'stream-beta',
      'Stream Beta',
      'Read evidence.txt, then report completion.',
      'readWorkspaceFile',
    ],
    [
      'parked-grant',
      'Parked Grant',
      'Read evidence.txt and report its marker.',
      'readWorkspaceFile',
    ],
    ['parked-stop', 'Parked Stop', 'Read evidence.txt and report its marker.', 'readWorkspaceFile'],
  ] as const;
  await Promise.all(
    personas.map(([file, name, body, tool]) =>
      writeFile(
        path.join(agents, `${file}.md`),
        `---\nname: ${name}\ndescription: BST-1770 assembled fixture specialist.${tool ? `\ntools:\n  - ${tool}` : ''}\n---\n${body}`
      )
    )
  );
  await writeFile(path.join(workspace, 'evidence.txt'), 'ASSEMBLED_EVIDENCE_1770');

  const alpha = Promise.withResolvers<void>();
  const beta = Promise.withResolvers<void>();
  const streams = Promise.withResolvers<void>();
  const requests: ModelProviderRequest[] = [];
  const provider = await startModelProviderShim((request) => {
    requests.push(request);
    if (request.toolNames.length === 0) {
      return { finalText: 'Assembled specialist task' };
    }
    const users = userHistory(request);
    const history = JSON.stringify(request.messages);
    if (request.toolNames.includes('agent-stream-alpha')) {
      if (
        history.includes(assembledMarkers.streamB) &&
        history.includes(assembledMarkers.parkedApproved) &&
        history.includes('PARKED_STOP_SURVIVOR_COMPLETE_1770')
      ) {
        return { finalText: assembledMarkers.parentResult };
      }
      if (hasAssistantToolCall(request, 'agent-stream-alpha')) {
        return { finalText: 'ASSEMBLED_ROOT_CONTINUES_1770' };
      }
      // Work permits are FIFO by arrival (docs/agents/assistant-subagents.md) and the
      // streams hold theirs, so the parked children are dispatched first. The streams'
      // dispatch finishes only once releaseStreams() reports that both parked children
      // asked to read, which released their permits.
      if (hasAssistantToolCall(request, 'agent-parked-grant')) {
        return {
          beforeToolFinish: streams.promise,
          finalText: 'ASSEMBLED_ROOT_CONTINUES_1770',
          ignorePriorToolResults: true,
          toolCalls: [
            {
              arguments: {
                _background: { enabled: true },
                prompt: 'STREAM_ALPHA_TASK_1770',
              },
              name: 'agent-stream-alpha',
            },
            {
              arguments: {
                _background: { enabled: true },
                prompt: 'STREAM_BETA_TASK_1770',
              },
              name: 'agent-stream-beta',
            },
          ],
        };
      }
      return {
        finalText: 'ASSEMBLED_ROOT_CONTINUES_1770',
        toolCalls: [
          {
            arguments: {
              _background: { enabled: true },
              prompt: 'PARKED_GRANT_TASK_1770',
            },
            name: 'agent-parked-grant',
          },
          {
            arguments: {
              _background: { enabled: true },
              prompt: 'PARKED_STOP_TASK_1770',
            },
            name: 'agent-parked-stop',
          },
        ],
      };
    }
    if (users.includes('STREAM_ALPHA_TASK_1770')) {
      return {
        beforeToolFinish: alpha.promise,
        finalText: assembledMarkers.streamA,
        toolCall: {
          arguments: { path: 'evidence.txt' },
          name: 'brainstrike_readWorkspaceFile',
        },
      };
    }
    if (users.includes('STREAM_BETA_TASK_1770')) {
      return {
        beforeToolFinish: beta.promise,
        finalText: assembledMarkers.streamB,
        toolCall: {
          arguments: { path: 'evidence.txt' },
          name: 'brainstrike_readWorkspaceFile',
        },
      };
    }
    return {
      finalText: users.includes('PARKED_STOP_TASK_1770')
        ? 'PARKED_STOP_SURVIVOR_COMPLETE_1770'
        : assembledMarkers.parkedApproved,
      toolCall: {
        arguments: { path: 'evidence.txt' },
        name: 'brainstrike_readWorkspaceFile',
      },
    };
  });
  return {
    environment: {
      ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: workspace,
      ['BRAINSTRIKE_OPENROUTER_API_KEY']: 'assembled-subagent-fixture-key',
      ['OPENROUTER_BASE_URL']: provider.baseUrl,
    },
    provider,
    releaseAlpha: alpha.resolve,
    releaseBeta: beta.resolve,
    releaseStreams: streams.resolve,
    requests: () => [...requests],
  };
}
