import {
  type ElicitRequestFormParams,
  inputRequired,
  inputResponse,
  McpServer,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { OFFICIAL_EVERYTHING_PROFILE as profile } from './official-everything-profile.js';
import type { McpLabFixture } from './scenario.js';
import { TASKS_PROFILE as tasks } from './tasks-profile.js';
import { installTasksServerWireAlias, TASKS_WIRE_ALIASES } from './tasks-wire-alias.js';

function createBrainstrikeEchoReferenceServer(): McpServer {
  const server = new McpServer({
    name: 'brainstrike-sdk-v2-reference',
    version: '2.0.0',
  });
  const echoSchema = z.strictObject({ text: z.string() });
  server.registerTool(
    'echo',
    {
      description: 'Echo a string through the official MCP TypeScript SDK v2 server.',
      inputSchema: echoSchema,
      outputSchema: echoSchema,
    },
    async ({ text }) => ({
      content: [{ text, type: 'text' }],
      structuredContent: { text },
    })
  );
  const elicitConfirmOutputSchema = z.strictObject({ confirmed: z.boolean(), text: z.string() });
  server.registerTool(
    'elicit_confirm',
    {
      description:
        'Ask the connected client to confirm a string through MCP form elicitation before echoing it.',
      inputSchema: echoSchema,
      outputSchema: elicitConfirmOutputSchema,
    },
    async ({ text }, ctx) => {
      const requestedSchema: ElicitRequestFormParams['requestedSchema'] = {
        properties: {
          confirm: {
            description: `Confirm that "${text}" may be echoed back.`,
            title: 'Confirm',
            type: 'boolean',
          },
          note: { maxLength: 80, title: 'Note', type: 'string' },
        },
        required: ['confirm'],
        type: 'object',
      };
      const message = `Confirm the reference elicitation for "${text}".`;
      const negotiated = server.server.getNegotiatedProtocolVersion();
      let confirmed: boolean;
      if (negotiated === '2026-07-28') {
        // Modern era: elicitation rides the multi-round-trip result. The client
        // answers the embedded request and retries with `inputResponses`; a
        // decline or cancel is a final answer, never a reason to re-ask.
        const answer = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
        if (answer.kind === 'missing') {
          return inputRequired({
            inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema }) },
          });
        }
        confirmed =
          answer.kind === 'elicit' &&
          answer.action === 'accept' &&
          answer.content?.['confirm'] === true;
      } else {
        // Legacy era: the 2025 push-style server-to-client request.
        const result = await ctx.mcpReq.elicitInput({ message, mode: 'form', requestedSchema });
        confirmed = result.action === 'accept' && result.content?.['confirm'] === true;
      }
      const echoed = confirmed ? text : 'elicitation was not accepted';
      return {
        content: [{ text: echoed, type: 'text' }],
        structuredContent: { confirmed, text: echoed },
      };
    }
  );
  return server;
}

/**
 * Representative modern profile copied from the official SDK v2 everything
 * server at the exact source recorded by MCP_LAB_OFFICIAL_EVERYTHING_SERVER_SOURCE.
 * Keep the names, capability declarations, and literal responses aligned with
 * that source; this deliberately stays bounded instead of vendoring its full
 * process-global conformance fixture.
 */
function createOfficialEverythingReferenceServer(): McpServer {
  const server = new McpServer(profile.server, { capabilities: profile.capabilities });

  server.registerTool(
    profile.tools.simpleText.name,
    { description: profile.tools.simpleText.description },
    async () => ({
      content: [{ text: profile.tools.simpleText.text, type: 'text' }],
    })
  );
  server.registerTool(
    profile.tools.error.name,
    { description: profile.tools.error.description },
    async () => {
      throw new Error(profile.tools.error.message);
    }
  );
  server.registerResource(
    profile.resource.name,
    profile.resource.uri,
    {
      description: profile.resource.description,
      mimeType: profile.resource.mimeType,
      title: profile.resource.title,
    },
    async () => ({
      contents: [
        {
          mimeType: profile.resource.mimeType,
          text: profile.resource.text,
          uri: profile.resource.uri,
        },
      ],
    })
  );
  server.registerPrompt(
    profile.prompt.name,
    {
      description: profile.prompt.description,
      title: profile.prompt.title,
    },
    async () => ({
      messages: [
        {
          content: { text: profile.prompt.message, type: 'text' },
          role: 'user',
        },
      ],
    })
  );
  server.server.setRequestHandler('completion/complete', async () => ({
    completion: { ...profile.completion, values: [...profile.completion.values] },
  }));
  return server;
}

type TaskStatus = 'cancelled' | 'completed' | 'input_required' | 'working';

interface TaskState {
  readonly createdAt: string;
  lastUpdatedAt: string;
  observed: number;
  status: TaskStatus;
}

const TASK_REQUEST_PARAMS = z.object({ taskId: z.string() }).passthrough();
const TASK_RESULT = z.object({}).passthrough();

/**
 * Deterministic black-box Tasks server driven by {@link TASKS_PROFILE}: one
 * tool starts a task; the first `tasks/get` observes `working`, the second
 * `input_required` with one elicitation input request; `tasks/update` with
 * that input completes the task; `tasks/cancel` cancels a non-terminal task;
 * unknown ids are rejected; every transition also emits the optional status
 * notification.
 */
/** One task store per handler: the modern handler builds a server per request. */
interface TaskStore {
  sequence: number;
  readonly states: Map<string, TaskState>;
}

function createTasksReferenceServer(store: TaskStore): McpServer {
  const server = new McpServer(tasks.server, { capabilities: tasks.capabilities });
  const { states } = store;
  const now = (): string => new Date().toISOString();
  /** The detailed task: status-specific fields ride on results AND notifications. */
  const projection = (taskId: string, state: TaskState) => ({
    createdAt: state.createdAt,
    lastUpdatedAt: state.lastUpdatedAt,
    pollIntervalMs: tasks.task.pollIntervalMs,
    status: state.status,
    taskId,
    ttlMs: tasks.task.ttlMs,
    ...(state.status === 'input_required'
      ? { inputRequests: { [tasks.input.key]: tasks.input.request } }
      : {}),
    ...(state.status === 'completed' ? { result: tasks.result } : {}),
  });
  const requireTask = (taskId: string): TaskState => {
    const state = states.get(taskId);
    if (!state) {
      throw new Error(`MCP Tasks reference task "${taskId}" does not exist`);
    }
    return state;
  };
  // The pinned server's `subscriptions/listen` bus models only the four spec
  // change events, so the optional status notification can only travel on the
  // stream of the request that caused the transition.
  const transition = async (
    taskId: string,
    state: TaskState,
    status: TaskStatus,
    relatedRequestId: string | number
  ) => {
    state.status = status;
    state.lastUpdatedAt = now();
    await server.server.notification(
      { method: tasks.notificationMethod, params: projection(taskId, state) },
      { relatedRequestId }
    );
  };

  server.registerTool(tasks.tool.name, { description: tasks.tool.description }, async () => {
    store.sequence += 1;
    const taskId = `reference-task-${store.sequence}`;
    const createdAt = now();
    states.set(taskId, { createdAt, lastUpdatedAt: createdAt, observed: 0, status: 'working' });
    return {
      content: [],
      createdAt,
      lastUpdatedAt: createdAt,
      pollIntervalMs: tasks.task.pollIntervalMs,
      resultType: 'task',
      status: 'working',
      taskId,
      ttlMs: tasks.task.ttlMs,
    } as never;
  });
  server.server.setRequestHandler(
    TASKS_WIRE_ALIASES['tasks/get'],
    { params: TASK_REQUEST_PARAMS, result: TASK_RESULT },
    async ({ taskId }, context) => {
      const state = requireTask(taskId);
      state.observed += 1;
      if (state.status === 'working' && state.observed >= 2) {
        await transition(taskId, state, 'input_required', context.mcpReq.id);
      }
      return projection(taskId, state);
    }
  );
  server.server.setRequestHandler(
    TASKS_WIRE_ALIASES['tasks/update'],
    { params: TASK_REQUEST_PARAMS, result: TASK_RESULT },
    async ({ taskId }, context) => {
      const state = requireTask(taskId);
      // The pinned 2026-07-28 server lifts the reserved retry-channel names
      // (`inputResponses`, `requestState`) off every client request's params
      // and surfaces them on the handler context; `tasks/update` reuses them.
      const inputResponses = context.mcpReq.inputResponses;
      if (state.status !== 'input_required' || inputResponses?.[tasks.input.key] === undefined) {
        throw new Error(`MCP Tasks reference task "${taskId}" is not awaiting input`);
      }
      await transition(taskId, state, 'completed', context.mcpReq.id);
      return {};
    }
  );
  server.server.setRequestHandler(
    TASKS_WIRE_ALIASES['tasks/cancel'],
    { params: TASK_REQUEST_PARAMS, result: TASK_RESULT },
    async ({ taskId }, context) => {
      const state = requireTask(taskId);
      if (state.status === 'completed' || state.status === 'cancelled') {
        throw new Error(`MCP Tasks reference task "${taskId}" is already terminal`);
      }
      await transition(taskId, state, 'cancelled', context.mcpReq.id);
      return {};
    }
  );
  return installTasksServerWireAlias(server);
}

/**
 * Per-handler server factory. Every fixture but Tasks is stateless, so a
 * fresh server per request is exact; the Tasks fixture shares one task store
 * across the per-request servers the modern handler allocates.
 */
export function createReferenceServerFactory(fixture: McpLabFixture): () => McpServer {
  if (fixture !== 'brainstrike-tasks-reference') {
    return () => createReferenceServer(fixture);
  }
  const store: TaskStore = { sequence: 0, states: new Map() };
  return () => createTasksReferenceServer(store);
}

export function createReferenceServer(fixture: McpLabFixture): McpServer {
  if (fixture === 'official-sdk-v2-everything-reference') {
    return createOfficialEverythingReferenceServer();
  }
  if (fixture === 'brainstrike-tasks-reference') {
    return createTasksReferenceServer({ sequence: 0, states: new Map() });
  }
  return createBrainstrikeEchoReferenceServer();
}
