import { createHash } from 'node:crypto';
import {
  parseMcpCancelTaskResult,
  parseMcpCreateTaskResult,
  parseMcpGetTaskResult,
  parseMcpTaskStatusNotificationParams,
  parseMcpUpdateTaskResult,
} from '@brainstrike/mcp-tasks-extension';
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import { APPS_PROFILE } from './apps-profile.js';
import {
  createMcpOAuthAuthorizationResponseVerifier,
  type McpLabCleanupReport,
  type McpLabSession,
  startMcpLabScenario,
} from './lab.js';
import type {
  McpLabRunnerCaseObservation,
  McpLabRunnerDependencies,
  McpLabRunnerPhase,
  McpLabRunnerPhaseOwner,
} from './runner.js';
import type { McpLabRunnerCase } from './runner-manifest.js';
import { TASKS_PROFILE } from './tasks-profile.js';
import {
  installTasksClientWireAlias,
  restoreCompleteResultType,
  TASKS_WIRE_ALIASES,
  type TasksWireMethod,
  unwrapTasksToolResult,
} from './tasks-wire-alias.js';

const REDIRECT_URI = 'http://127.0.0.1:54321/callback';
const PKCE_VERIFIER = 'brainstrike-runner-pkce-verifier-000000000000000000000000';

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`MCP reference runner ${label} is not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`MCP reference runner ${label} is not a string`);
  }
  return value;
}

async function authorize(lab: McpLabSession, signal: AbortSignal): Promise<string> {
  if (lab.endpoint.kind !== 'oauth-loopback-http') {
    throw new Error(`Expected OAuth endpoint, received ${lab.endpoint.kind}`);
  }
  const endpoint = lab.endpoint;
  const registrationResponse = await fetch(endpoint.registrationUrl, {
    body: JSON.stringify({
      ['application_type']: 'native',
      ['client_name']: 'Brainstrike MCP verifier runner',
      ['grant_types']: ['authorization_code'],
      ['redirect_uris']: [REDIRECT_URI],
      ['response_types']: ['code'],
      ['token_endpoint_auth_method']: 'none',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal,
  });
  if (registrationResponse.status !== 201) {
    throw new Error('MCP reference runner OAuth registration failed');
  }
  const registration = record(await registrationResponse.json(), 'registration');
  const clientId = stringValue(registration['client_id'], 'client id');
  const state = 'runner-state';
  const authorizationUrl = new URL(endpoint.authorizationUrl);
  authorizationUrl.search = new URLSearchParams({
    ['client_id']: clientId,
    ['code_challenge']: createHash('sha256').update(PKCE_VERIFIER).digest('base64url'),
    ['code_challenge_method']: 'S256',
    ['redirect_uri']: REDIRECT_URI,
    resource: endpoint.url.href,
    ['response_type']: 'code',
    scope: 'mcp',
    state,
  }).toString();
  const authorization = await fetch(authorizationUrl, { redirect: 'manual', signal });
  if (authorization.status !== 302) {
    throw new Error('MCP reference runner OAuth authorization failed');
  }
  const callback = new URL(stringValue(authorization.headers.get('location'), 'callback'));
  const code = createMcpOAuthAuthorizationResponseVerifier({
    endpoint,
    expectedRedirectUri: REDIRECT_URI,
    expectedState: state,
  })(callback);
  const tokenResponse = await fetch(endpoint.tokenUrl, {
    body: new URLSearchParams({
      ['client_id']: clientId,
      code,
      ['code_verifier']: PKCE_VERIFIER,
      ['grant_type']: 'authorization_code',
      ['redirect_uri']: REDIRECT_URI,
      resource: endpoint.url.href,
    }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
    signal,
  });
  if (tokenResponse.status !== 200) {
    throw new Error('MCP reference runner OAuth token exchange failed');
  }
  return stringValue(
    record(await tokenResponse.json(), 'token response')['access_token'],
    'access token'
  );
}

function startCase(runnerCase: McpLabRunnerCase): Promise<McpLabSession> {
  if (runnerCase.scenarioId === 'stdio-reference') {
    return startMcpLabScenario('stdio-reference', {});
  }
  if (runnerCase.scenarioId === 'oauth-reference') {
    return startMcpLabScenario('oauth-reference', { execution: 'loopback' });
  }
  if (!runnerCase.execution) {
    throw new Error(`MCP reference runner case "${runnerCase.id}" has no HTTP execution`);
  }
  return startMcpLabScenario(runnerCase.scenarioId, { execution: runnerCase.execution });
}

const EXPECTED_TOOLS: Readonly<Record<McpLabRunnerCase['scenarioId'], string>> = Object.freeze({
  'apps-reference': APPS_PROFILE.tool.name,
  'legacy-reference': 'echo',
  'modern-reference': 'test_simple_text',
  'oauth-reference': 'echo',
  'stdio-reference': 'echo',
  'tasks-reference': TASKS_PROFILE.tool.name,
});

function expectedToolFor(scenarioId: McpLabRunnerCase['scenarioId']): string {
  return EXPECTED_TOOLS[scenarioId];
}

const RED_SUFFIXES: Readonly<Partial<Record<McpLabRunnerCase['scenarioId'], string>>> =
  Object.freeze({
    'apps-reference': '-missing-resource-rejection',
    'modern-reference': '-intentional-tool-error',
    'tasks-reference': '-missing-task-rejection',
  });

/**
 * Black-box MCP Apps matrix (BST-1572) over the derived profile of the pinned
 * official example server: the app tool advertises both resource-URI metadata
 * keys, the linked `ui://` resource is listed and read with the MCP Apps MIME
 * profile and the exact pinned document, and the tool call returns the
 * structured output the example declares.
 */
async function probeAppsCapabilities(client: Client, signal: AbortSignal): Promise<boolean> {
  const tools = await client.listTools(undefined, { signal });
  const tool = tools.tools.find(({ name }) => name === APPS_PROFILE.tool.name);
  const resources = await client.listResources(undefined, { signal });
  const resource = await client.readResource({ uri: APPS_PROFILE.resource.uri }, { signal });
  const call = await client.callTool({ arguments: {}, name: APPS_PROFILE.tool.name }, { signal });
  const structured =
    typeof call.structuredContent === 'object' && call.structuredContent !== null
      ? (call.structuredContent as Record<string, unknown>)
      : {};
  const time = structured[APPS_PROFILE.tool.outputKey];
  const contents = resource.contents[0];
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ['app tool is listed', tool !== undefined],
    [
      'app tool carries both resource-URI metadata keys',
      canonicalJson(tool?._meta) === canonicalJson(APPS_PROFILE.tool.meta),
    ],
    ['app tool declares the structured output', tool?.outputSchema !== undefined],
    [
      'linked ui resource is listed with the MCP Apps MIME profile',
      resources.resources.some(
        ({ mimeType, uri }) =>
          uri === APPS_PROFILE.resource.uri && mimeType === APPS_PROFILE.resource.mimeType
      ),
    ],
    ['resource read returns exactly one content', resource.contents.length === 1],
    [
      'resource read carries the MIME profile and the pinned document',
      contents !== undefined &&
        contents.mimeType === APPS_PROFILE.resource.mimeType &&
        'text' in contents &&
        contents.text === APPS_PROFILE.document,
    ],
    [
      'tool call returns an ISO 8601 time',
      typeof time === 'string' && !Number.isNaN(Date.parse(time)),
    ],
    [
      'tool call text mirrors the structured time',
      call.content.some((entry) => entry.type === 'text' && entry.text === time),
    ],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`MCP Apps reference matrix failed: ${failed.join('; ')}`);
  }
  return true;
}

function correlationSuffix(runnerCase: McpLabRunnerCase, phase: McpLabRunnerPhase): string {
  if (phase !== 'red') {
    return '';
  }
  return RED_SUFFIXES[runnerCase.scenarioId] ?? '-missing-tool-rejection';
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
        )
      : entry
  );
}

async function requestTasks<Result>(
  client: Client,
  method: TasksWireMethod,
  params: Record<string, unknown>,
  parse: (value: unknown) => Result,
  signal: AbortSignal
): Promise<Result> {
  const raw = await client.request({ method: TASKS_WIRE_ALIASES[method], params }, z.unknown(), {
    signal,
  });
  return parse(restoreCompleteResultType(raw));
}

/**
 * Schema-derived black-box Tasks matrix (BST-1566): every response is parsed
 * with the extension's own parsers, the observable timeline must match the
 * profile, mid-flight input is delivered through `tasks/update`, a second task
 * proves cancellation, and the optional status notification is observed.
 */
async function probeTasksCapabilities(client: Client, signal: AbortSignal): Promise<boolean> {
  const notifications: string[] = [];
  const notificationErrors: string[] = [];
  client.setNotificationHandler(
    TASKS_PROFILE.notificationMethod,
    { params: z.unknown() },
    (params: unknown) => {
      // The SDK swallows handler throws; record them so the matrix fails loudly.
      try {
        notifications.push(parseMcpTaskStatusNotificationParams(params).status);
      } catch (error) {
        notificationErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
  );
  const created = parseMcpCreateTaskResult(
    unwrapTasksToolResult(
      await client.request(
        { method: 'tools/call', params: { arguments: {}, name: TASKS_PROFILE.tool.name } },
        z.unknown(),
        { signal }
      )
    )
  );
  const first = await requestTasks(
    client,
    'tasks/get',
    { taskId: created.taskId },
    parseMcpGetTaskResult,
    signal
  );
  const second = await requestTasks(
    client,
    'tasks/get',
    { taskId: created.taskId },
    parseMcpGetTaskResult,
    signal
  );
  if (second.status !== 'input_required') {
    throw new Error(
      `MCP Tasks reference matrix failed: second tasks/get expected input_required, got ${second.status} (first ${first.status})`
    );
  }
  const inputRequest = second.inputRequests[TASKS_PROFILE.input.key];
  await requestTasks(
    client,
    'tasks/update',
    {
      inputResponses: { [TASKS_PROFILE.input.key]: TASKS_PROFILE.input.response },
      taskId: created.taskId,
    },
    parseMcpUpdateTaskResult,
    signal
  );
  const completed = await requestTasks(
    client,
    'tasks/get',
    { taskId: created.taskId },
    parseMcpGetTaskResult,
    signal
  );
  const cancellable = parseMcpCreateTaskResult(
    unwrapTasksToolResult(
      await client.request(
        { method: 'tools/call', params: { arguments: {}, name: TASKS_PROFILE.tool.name } },
        z.unknown(),
        { signal }
      )
    )
  );
  await requestTasks(
    client,
    'tasks/cancel',
    { taskId: cancellable.taskId },
    parseMcpCancelTaskResult,
    signal
  );
  const cancelled = await requestTasks(
    client,
    'tasks/get',
    { taskId: cancellable.taskId },
    parseMcpGetTaskResult,
    signal
  );
  const timeline = [first.status, second.status, completed.status];
  const expectedTimeline: readonly string[] = TASKS_PROFILE.timeline;
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ['tool result is a task', created.resultType === 'task'],
    ['created task starts working', created.status === expectedTimeline[0]],
    [
      'observed timeline matches the profile',
      JSON.stringify(timeline) === JSON.stringify(expectedTimeline),
    ],
    [
      'input request matches the profile',
      canonicalJson(inputRequest) === canonicalJson(TASKS_PROFILE.input.request),
    ],
    [
      'completed task carries the profile result',
      canonicalJson(completed.result) === canonicalJson(TASKS_PROFILE.result),
    ],
    ['second task is cancelled', cancelled.status === 'cancelled'],
    ['input_required status notification observed', notifications.includes('input_required')],
    ['completed status notification observed', notifications.includes('completed')],
    ['cancelled status notification observed', notifications.includes('cancelled')],
    ['every status notification parsed', notificationErrors.length === 0],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(
      `MCP Tasks reference matrix failed: ${failed.join('; ')} (timeline ${JSON.stringify(timeline)}, notifications ${JSON.stringify(notifications)}, inputRequest ${JSON.stringify(inputRequest)}, notificationErrors ${JSON.stringify(notificationErrors)})`
    );
  }
  return true;
}

export function isMissingToolProtocolError(error: unknown, toolName: string): boolean {
  return (
    error instanceof ProtocolError &&
    error.code === ProtocolErrorCode.InvalidParams &&
    error.message.includes(toolName)
  );
}

function assertCleanup(runnerCase: McpLabRunnerCase, report: McpLabCleanupReport): string {
  if (report.untriggeredFaultIds.length !== 0) {
    throw new Error(`MCP reference runner case "${runnerCase.id}" left faults untriggered`);
  }
  const expectedListeners = runnerCase.execution === 'loopback' ? 1 : 0;
  const expectedStdio = runnerCase.scenarioId === 'stdio-reference' ? 1 : 0;
  if (
    report.httpListenersClosed !== expectedListeners ||
    report.stdioTransportsClosed !== expectedStdio
  ) {
    throw new Error(`MCP reference runner case "${runnerCase.id}" cleanup counts are invalid`);
  }
  if (
    'oauthRecordsRemaining' in report &&
    Object.values(report.oauthRecordsRemaining).some((count) => count !== 0)
  ) {
    throw new Error(`MCP reference runner case "${runnerCase.id}" retained OAuth records`);
  }
  return `closed listeners=${expectedListeners} stdio=${expectedStdio}`;
}

function echoText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('structuredContent' in value)) {
    return;
  }
  const structured = value.structuredContent;
  if (typeof structured !== 'object' || structured === null || !('text' in structured)) {
    return;
  }
  return typeof structured.text === 'string' ? structured.text : undefined;
}

function hasTextContent(value: unknown, expected: string): boolean {
  if (typeof value !== 'object' || value === null || !('content' in value)) {
    return false;
  }
  return (
    Array.isArray(value.content) &&
    value.content.some(
      (entry) =>
        typeof entry === 'object' && entry !== null && 'text' in entry && entry.text === expected
    )
  );
}

async function probeModernCapabilities(client: Client, signal: AbortSignal): Promise<boolean> {
  const tool = await client.callTool({ name: 'test_simple_text' }, { signal });
  const resources = await client.listResources(undefined, { signal });
  const resource = await client.readResource({ uri: 'test://static-text' }, { signal });
  const prompts = await client.listPrompts(undefined, { signal });
  const prompt = await client.getPrompt({ name: 'test_simple_prompt' }, { signal });
  const completion = await client.complete(
    {
      argument: { name: 'unused', value: '' },
      ref: { name: 'test_simple_prompt', type: 'ref/prompt' },
    },
    { signal }
  );
  const subscription = await client.listen({}, { signal });
  await subscription.close();
  return (
    hasTextContent(tool, 'This is a simple text response for testing.') &&
    resources.resources.some(({ uri }) => uri === 'test://static-text') &&
    resource.contents.some(
      (entry) =>
        'text' in entry && entry.text === 'This is the content of the static text resource.'
    ) &&
    prompts.prompts.some(({ name }) => name === 'test_simple_prompt') &&
    prompt.messages.some(
      ({ content }) =>
        content.type === 'text' && content.text === 'This is a simple prompt for testing.'
    ) &&
    completion.completion.values.length === 0 &&
    completion.completion.total === 0 &&
    completion.completion.hasMore === false
  );
}

function isIntentionalToolError(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isError' in value &&
    value.isError === true &&
    'content' in value &&
    Array.isArray(value.content) &&
    value.content.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        'text' in entry &&
        typeof entry.text === 'string' &&
        entry.text.includes('intentionally returns an error')
    )
  );
}

/**
 * RED probes assert the handler's OWN rejection. Any ProtocolError is too
 * weak: a broken alias bridge or a params regression also yields one
 * (method-not-found before dispatch, invalid params), so each probe pins the
 * code and the identifier its reference server names.
 */
async function expectProtocolRejection(
  action: () => Promise<unknown>,
  description: string,
  accept: (error: ProtocolError) => boolean
): Promise<false> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ProtocolError && accept(error)) {
      return false;
    }
    throw error;
  }
  throw new Error(`MCP reference runner RED ${description} was not rejected`);
}

async function runModernRed(client: Client, signal: AbortSignal): Promise<false> {
  const result = await client.callTool({ name: 'test_error_handling' }, { signal });
  if (!isIntentionalToolError(result)) {
    throw new Error('MCP reference runner RED tool did not return the pinned intentional error');
  }
  return false;
}

async function runEchoRed(client: Client, value: string, signal: AbortSignal): Promise<false> {
  try {
    await client.callTool({ arguments: { text: value }, name: 'missing-red-mutation' }, { signal });
  } catch (error) {
    if (isMissingToolProtocolError(error, 'missing-red-mutation')) {
      return false;
    }
    throw error;
  }
  throw new Error('MCP reference runner RED mutation did not produce a server rejection');
}

async function runReferenceTest(
  client: Client,
  runnerCase: McpLabRunnerCase,
  phase: McpLabRunnerPhase,
  value: string,
  signal: AbortSignal
): Promise<boolean> {
  const { scenarioId } = runnerCase;
  if (phase !== 'red') {
    switch (scenarioId) {
      case 'apps-reference':
        return probeAppsCapabilities(client, signal);
      case 'tasks-reference':
        return probeTasksCapabilities(client, signal);
      case 'modern-reference':
        return probeModernCapabilities(client, signal);
      default:
        return (
          echoText(
            await client.callTool({ arguments: { text: value }, name: 'echo' }, { signal })
          ) === value
        );
    }
  }
  switch (scenarioId) {
    case 'apps-reference':
      return expectProtocolRejection(
        () => client.readResource({ uri: APPS_PROFILE.missingResourceUri }, { signal }),
        'resources/read for a missing app resource',
        (error) =>
          error.code === ProtocolErrorCode.InvalidParams &&
          error.message.includes(APPS_PROFILE.missingResourceUri)
      );
    case 'tasks-reference':
      return expectProtocolRejection(
        () =>
          requestTasks(
            client,
            'tasks/get',
            { taskId: TASKS_PROFILE.missingTaskId },
            parseMcpGetTaskResult,
            signal
          ),
        'tasks/get for a missing task',
        (error) =>
          error.code === ProtocolErrorCode.InternalError &&
          error.message.includes(TASKS_PROFILE.missingTaskId)
      );
    case 'modern-reference':
      return runModernRed(client, signal);
    default:
      return runEchoRed(client, value, signal);
  }
}

type VerifierClientOptions = NonNullable<ConstructorParameters<typeof Client>[1]>;

/** The Apps scenario must advertise the MCP Apps host capability; nothing else does. */
function clientOptionsFor(
  scenarioId: McpLabRunnerCase['scenarioId'],
  protocol: { readonly era: 'legacy' | 'modern'; readonly version: string }
): VerifierClientOptions {
  const versionNegotiation: VerifierClientOptions['versionNegotiation'] =
    protocol.era === 'legacy' ? { mode: 'legacy' } : { mode: { pin: protocol.version } };
  if (scenarioId !== 'apps-reference') {
    return { versionNegotiation };
  }
  return {
    capabilities: {
      extensions: { [APPS_PROFILE.extensionId]: { mimeTypes: [...APPS_PROFILE.host.mimeTypes] } },
    },
    versionNegotiation,
  };
}

class ReferencePhaseOwner implements McpLabRunnerPhaseOwner {
  private client: Client | undefined;
  private closePromise: Promise<{ readonly details: string; readonly verified: true }> | undefined;
  private lab: McpLabSession | undefined;
  private startPromise: Promise<McpLabSession> | undefined;

  constructor(
    private readonly runnerCase: McpLabRunnerCase,
    private readonly phase: McpLabRunnerPhase,
    private readonly start: (runnerCase: McpLabRunnerCase) => Promise<McpLabSession>
  ) {}

  close(_signal: AbortSignal): Promise<{ readonly details: string; readonly verified: true }> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = (async () => {
      const failures: Error[] = [];
      if (this.startPromise) {
        try {
          this.lab ??= await this.startPromise;
        } catch {
          // The primary run path owns and reports startup failure. No lab was allocated.
        }
      }
      try {
        await this.client?.close();
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error('MCP client cleanup failed'));
      }
      let report: McpLabCleanupReport | undefined;
      try {
        report = await this.lab?.close();
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error('MCP lab cleanup failed'));
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `MCP reference runner cleanup failed for ${this.runnerCase.id}`
        );
      }
      const details = report ? assertCleanup(this.runnerCase, report) : 'closed before allocation';
      return Object.freeze({ details, verified: true as const });
    })();
    return this.closePromise;
  }

  async run(signal: AbortSignal): Promise<McpLabRunnerCaseObservation> {
    if (this.startPromise || this.closePromise) {
      throw new Error('MCP reference runner phase already ran');
    }
    this.startPromise = this.start(this.runnerCase);
    this.lab = await this.startPromise;
    signal.throwIfAborted();
    const protocol = this.lab.scenario.protocol;
    this.client = new Client(
      { name: 'brainstrike-mcp-verifier-runner', version: '1.0.0' },
      clientOptionsFor(this.runnerCase.scenarioId, protocol)
    );
    const endpoint = this.lab.endpoint;
    if (endpoint.kind === 'stdio') {
      await this.client.connect(endpoint.transport, { signal });
    } else {
      const accessToken =
        endpoint.kind === 'oauth-loopback-http' ? await authorize(this.lab, signal) : undefined;
      signal.throwIfAborted();
      const transport = new StreamableHTTPClientTransport(endpoint.url, {
        ...(endpoint.kind === 'in-process-http' ? { fetch: endpoint.fetch } : {}),
        ...(accessToken
          ? { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }
          : {}),
      });
      await this.client.connect(
        this.runnerCase.scenarioId === 'tasks-reference'
          ? installTasksClientWireAlias(transport)
          : transport,
        { signal }
      );
    }
    signal.throwIfAborted();
    const tools = await this.client.listTools(undefined, { signal });
    signal.throwIfAborted();
    const expectedTool = expectedToolFor(this.runnerCase.scenarioId);
    if (!tools.tools.some(({ name }) => name === expectedTool)) {
      throw new Error(`MCP reference runner server does not expose the ${expectedTool} tool`);
    }
    const value = `${this.runnerCase.id}-${this.phase}`;
    const passed = await runReferenceTest(this.client, this.runnerCase, this.phase, value, signal);
    signal.throwIfAborted();
    const negotiated = this.client.getNegotiatedProtocolVersion();
    if (negotiated !== protocol.version) {
      throw new Error(
        `MCP reference runner negotiated ${String(negotiated)} instead of ${protocol.version}`
      );
    }
    const serverCapabilities = this.client.getServerCapabilities();
    if (!serverCapabilities) {
      throw new Error('MCP reference runner has no negotiated server capabilities');
    }
    return Object.freeze({
      capabilities: Object.freeze(Object.keys(serverCapabilities).sort()),
      correlationIds: Object.freeze([
        `${this.runnerCase.id}-${this.phase}${correlationSuffix(this.runnerCase, this.phase)}`,
      ]),
      exitStatus: passed ? 0 : 1,
      negotiation:
        protocol.era === 'legacy'
          ? { era: protocol.era, revision: protocol.version }
          : { era: protocol.era, revision: protocol.version },
      tests: Object.freeze({
        failed: passed ? 0 : 1,
        passed: passed ? 1 : 0,
        skipped: 0,
        total: 1,
      }),
    });
  }
}

export function createMcpLabReferenceRunnerDependencies(
  options: { readonly startCase?: (runnerCase: McpLabRunnerCase) => Promise<McpLabSession> } = {}
): McpLabRunnerDependencies {
  const start = options.startCase ?? startCase;
  return Object.freeze({
    createPhaseOwner(runnerCase: McpLabRunnerCase, phase: McpLabRunnerPhase) {
      return new ReferencePhaseOwner(runnerCase, phase, start);
    },
    now: () => performance.now(),
  });
}
