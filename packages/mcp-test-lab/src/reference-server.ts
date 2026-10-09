import {
  completable,
  type ElicitRequestFormParams,
  inputRequired,
  inputResponse,
  McpServer,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { APPS_PROFILE as apps } from './apps-profile.js';
import { OFFICIAL_EVERYTHING_PROFILE as profile } from './official-everything-profile.js';
import type { McpLabFixture } from './scenario.js';
import { TASKS_PROFILE as tasks } from './tasks-profile.js';
import { installTasksServerWireAlias, TASKS_WIRE_ALIASES } from './tasks-wire-alias.js';

/**
 * Content surface of the Brainstrike echo fixture (BST-1592): one readable
 * resource and one argument-taking prompt, so `resources/read`, `prompts/get`,
 * and `completion/complete` (`ref/prompt`) are provable end to end against a
 * Brainstrike-owned fixture rather than the pinned official everything profile.
 *
 * `resources`/`prompts` capabilities are inferred by the SDK from
 * `registerResource`/`registerPrompt`; `completions` is inferred only from a
 * `completable()` argument, which also installs the SDK's own
 * `completion/complete` dispatcher (a hand-written handler for that method
 * would collide with it).
 */
export const ECHO_REFERENCE_CONTENT = Object.freeze({
  prompt: Object.freeze({
    argument: 'subject',
    completions: Object.freeze(['bst-1592-alpha', 'bst-1592-beta']),
    description: 'Ask the assistant to echo one reference subject.',
    message: (subject: string) => `Echo the reference subject "${subject}" back to me.`,
    name: 'echo_prompt',
    title: 'Echo reference prompt',
  }),
  resource: Object.freeze({
    description: 'Static notes served by the Brainstrike echo reference server.',
    mimeType: 'text/markdown',
    name: 'echo-reference-notes',
    text: '# Echo reference notes\n\nbst-1592-resource-body\n',
    title: 'Echo reference notes',
    uri: 'brainstrike://reference/echo-notes',
  }),
});

/**
 * The reference `elicit_confirm` tool: it asks the client to confirm `text`
 * through form elicitation (the modern multi-round-trip result, or the legacy
 * push request) before echoing it. `meta` lets a fixture attach an MCP App.
 */
export function registerElicitConfirmTool(
  server: McpServer,
  meta?: Readonly<Record<string, unknown>>
): void {
  const echoSchema = z.strictObject({ text: z.string() });
  const elicitConfirmOutputSchema = z.strictObject({ confirmed: z.boolean(), text: z.string() });
  server.registerTool(
    'elicit_confirm',
    {
      description:
        'Ask the connected client to confirm a string through MCP form elicitation before echoing it.',
      inputSchema: echoSchema,
      outputSchema: elicitConfirmOutputSchema,
      ...(meta ? { _meta: meta } : {}),
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
}

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
  registerElicitConfirmTool(server);
  const { prompt, resource } = ECHO_REFERENCE_CONTENT;
  server.registerResource(
    resource.name,
    resource.uri,
    { description: resource.description, mimeType: resource.mimeType, title: resource.title },
    async () => ({
      contents: [{ mimeType: resource.mimeType, text: resource.text, uri: resource.uri }],
    })
  );
  server.registerPrompt(
    prompt.name,
    {
      argsSchema: z.object({
        [prompt.argument]: completable(
          z.string().describe('The subject the assistant should echo.'),
          (value) => prompt.completions.filter((option) => option.startsWith(value))
        ),
      }),
      description: prompt.description,
      title: prompt.title,
    },
    async (args) => ({
      messages: [
        {
          content: { text: prompt.message(String(args[prompt.argument])), type: 'text' },
          role: 'user',
        },
      ],
    })
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
  transitions: number;
}

const TASK_REQUEST_PARAMS = z.object({ taskId: z.string() }).passthrough();
const TASK_RESULT = z.object({}).passthrough();

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
        )
      : entry
  );
}

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
  // Deterministic, profile-driven timestamps: identical runs expose identical
  // wire behaviour, so the profile digest really covers what is observed.
  const createdAtMs = Date.parse(tasks.task.createdAt);
  if (Number.isNaN(createdAtMs)) {
    throw new Error('MCP Tasks reference profile createdAt is not a valid timestamp');
  }
  const stamp = (transitions: number): string =>
    new Date(createdAtMs + transitions * tasks.task.pollIntervalMs).toISOString();
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
    state.transitions += 1;
    state.lastUpdatedAt = stamp(state.transitions);
    await server.server.notification(
      { method: tasks.notificationMethod, params: projection(taskId, state) },
      { relatedRequestId }
    );
  };

  server.registerTool(tasks.tool.name, { description: tasks.tool.description }, async () => {
    store.sequence += 1;
    const taskId = `reference-task-${store.sequence}`;
    const createdAt = stamp(0);
    states.set(taskId, {
      createdAt,
      lastUpdatedAt: createdAt,
      observed: 0,
      status: 'working',
      transitions: 0,
    });
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
      // The profile defines the exact expected response; a mangled or dropped
      // field must fail the proof, not complete the task.
      if (canonicalJson(inputResponses[tasks.input.key]) !== canonicalJson(tasks.input.response)) {
        throw new Error(
          `MCP Tasks reference task "${taskId}" received an unexpected input response`
        );
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
 * Derived from the pinned official ext-apps example server: one app tool whose
 * metadata links it to one `ui://` resource served with the MCP Apps MIME
 * profile. The wire shape is what `registerAppTool`/`registerAppResource`
 * produce at the pinned tag, without importing the ext-apps package.
 */
function createAppsReferenceServer(): McpServer {
  const server = new McpServer(apps.server, { capabilities: { resources: {}, tools: {} } });
  server.registerTool(
    apps.tool.name,
    {
      _meta: { ...apps.tool.meta, ui: { ...apps.tool.meta.ui } },
      description: apps.tool.description,
      inputSchema: {},
      outputSchema: { [apps.tool.outputKey]: z.string() },
      title: apps.tool.title,
    },
    async () => {
      const time = new Date().toISOString();
      return {
        content: [{ text: time, type: 'text' as const }],
        structuredContent: { [apps.tool.outputKey]: time },
      };
    }
  );
  server.registerResource(
    apps.resource.name,
    apps.resource.uri,
    { mimeType: apps.resource.mimeType },
    async () => {
      // Capability negotiation is part of the proof: only a client that
      // advertised the MCP Apps host capability with this MIME profile may
      // read the app document.
      const extension: unknown =
        server.server.getClientCapabilities()?.extensions?.[apps.extensionId];
      const mimeTypes =
        typeof extension === 'object' && extension !== null
          ? (extension as { mimeTypes?: unknown }).mimeTypes
          : undefined;
      if (!(Array.isArray(mimeTypes) && mimeTypes.includes(apps.resource.mimeType))) {
        throw new Error(
          `MCP Apps reference resource ${apps.resource.uri} requires the ${apps.extensionId} host capability with ${apps.resource.mimeType}`
        );
      }
      return {
        contents: [
          { mimeType: apps.resource.mimeType, text: apps.document, uri: apps.resource.uri },
        ],
      };
    }
  );
  return server;
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
    throw new Error(
      'MCP Tasks reference requires createReferenceServerFactory: the task store must outlive the per-request server'
    );
  }
  if (fixture === 'brainstrike-apps-reference') {
    return createAppsReferenceServer();
  }
  return createBrainstrikeEchoReferenceServer();
}
