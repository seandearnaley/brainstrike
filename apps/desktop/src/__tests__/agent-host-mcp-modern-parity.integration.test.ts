// @vitest-environment node
import { randomUUID } from 'node:crypto';
import {
  type McpTaskPresentation,
  parseConfiguredMcpServerId,
  readMcpAppToolInvocationResult,
} from '@brainstrike/assistant-contract';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { processStartTime } from '@brainstrike/state-store';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureToolRequest } from './fixtures/agent-host-adapter-fixture';
import {
  APP_MIME_TYPE,
  APP_RESOURCE_URI,
  APPS_SERVER,
  answerFor,
  answerPublicly,
  causeMessage,
  diagnostics,
  durableTask,
  eventOf,
  expectCanonicalTask,
  expectedTaskInput,
  firstOf,
  type LabProcess,
  LEASE_UNAVAILABLE,
  LEGACY_SERVER,
  liveServer,
  modelToolResult,
  Observed,
  openGuiInput,
  openModernHost,
  openTasksHost,
  owned,
  type PublicInput,
  releaseOwned,
  reopenAndRecover,
  requirePresentation,
  requireTaskHandle,
  startLab,
  startThreadRun,
  TASK_INPUT_REQUEST,
  TASKS_SERVER,
} from './fixtures/agent-host-mcp-modern-harness';
import { expectHostPrivateFailure } from './fixtures/host-private-boundary-failure';

// BST-1930/BST-1931: the lab in a forked plain-Node child over loopback HTTP (2026-07-28), the
// shipped collector, MCP runtime, production platform and Core behind the public host/client
// protocol, and disposable Root SQLite plus PGlite Tasks storage. Only the model is scripted.
// Server input is host-owned: Core commits it, and it is answered only through the public
// `mcp/input/read -> stage -> settle` client (ruling #3543 6052085707 C).

afterEach(releaseOwned);

const REFUSED = 'MCP Tasks reference task "reference-task-1" received an unexpected input response';
const UNKNOWN =
  'MCP task "reference-task-1" input "approval" has an unknown delivery outcome; it is not resent.';
const APPROVE = { action: 'accept', content: { approved: true } } as const;
/** A restarted host replays its thread; only a freshly requested input is a recovery. */
const requested = (items: readonly PublicInput[]): PublicInput | undefined =>
  items.find(({ status }) => status === 'requested');

describe('modern MCP host parity over the loopback lab (BST-1930, BST-1931)', () => {
  it('settles a modern Task input through the admitted executor, the canonical task authority and the Tasks database', async (context) => {
    const lab = await startLab('tasks-reference', context.signal);
    const modern = await openTasksHost(lab, { policy: 'ask' });
    const { log, runId, threadId } = await startThreadRun(modern, 'Start the task');
    const approval = await log.until((rows) => eventOf(rows, 'interaction.requested'));
    expect(approval).toMatchObject({ kind: 'approval', runId, toolId: modern.toolId });
    const server = liveServer(modern.services);
    expect(server).toMatchObject({
      configuredServerId: TASKS_SERVER,
      extensions: { apps: false, tasks: true },
      negotiated: { revision: '2026-07-28' },
      state: 'connected',
    });
    expect(eventOf(log.rows(), 'run.started')?.snapshot?.mcpAuthorities).toEqual({
      [modern.toolId]: {
        auth: { type: 'none' },
        destination: lab.ready.endpoint,
        extensions: { apps: false, tasks: true },
        kind: 'http',
        protocol: '2026-07-28',
        transport: 'streamable-http',
        version: 1,
      },
    });
    expect(modern.inputs.items).toEqual([]);
    // The shipped GUI controller (2bfe) watches the same thread through the public client.
    const { gui, snapshots } = await openGuiInput(modern.client, threadId);
    await modern.client.request('interaction/respond', {
      commandId: randomUUID(),
      decision: 'approve',
      interactionId: approval.interactionId,
      runId,
      threadId,
    });
    const input = await modern.inputs.until((items) => items[0]);
    const presentation = requirePresentation(input);
    const handle = requireTaskHandle(presentation);
    expect(presentation).toEqual(
      expectedTaskInput(
        server.generation,
        { target: 'start_task', type: 'tools/call' },
        {
          authorityEpoch: expect.any(String),
          principalId: 'none',
          resource: lab.ready.endpoint,
          serverId: TASKS_SERVER,
          taskId: 'reference-task-1',
        }
      )
    );
    expect(await durableTask(modern.storage, handle)).toMatchObject({
      ...handle,
      resultMetadata: null,
      status: 'input_required',
    });
    // Negative controls through the public client: invalid values, then a stale address.
    await expectHostPrivateFailure(
      () =>
        modern.client.request('mcp/input/stage', {
          ...input.address,
          content: { approved: 'yes' },
        }),
      'mcp/input/stage'
    );
    await expectHostPrivateFailure(
      () => answerPublicly(modern.client, { ...input.address, runId: randomUUID() }, APPROVE),
      'mcp/input/stage'
    );
    // A real GUI answer: one decision, committed by Core before native delivery.
    await snapshots.until((items) =>
      items.find((snapshot) => snapshot.input?.presentation?.id === presentation.id)
    );
    await gui.settle(answerFor(presentation, 'accept'));
    // Exact-once authorization: once Core holds the intent, a second command is refused.
    await expectHostPrivateFailure(
      () => answerPublicly(modern.client, input.address, APPROVE),
      'mcp/input/stage'
    );
    expect(await log.finished()).toMatchObject({ outcome: 'completed', runId });
    const effect = await log.effect();
    expect(effect).toMatchObject({
      input: {},
      toolId: modern.toolId,
      toolIdentity: JSON.stringify([TASKS_SERVER, server.generation, modern.toolId]),
    });
    await expectCanonicalTask(modern, log.rows(), effect.toolCallId, handle, [
      'working',
      'working',
      'input_required',
      'completed',
    ]);
    expect((await durableTask(modern.storage, handle)).resultMetadata).toEqual({
      lifecycle: expect.any(Object),
      result: { content: [{ text: 'done', type: 'text' }] },
    });
    await log.until((rows) => eventOf(rows, 'mcp.input.settled'));
    // One request, one intent and its positive receipt; durable history keeps no private value.
    expect(
      log.rows().flatMap(({ event }): string[][] => {
        if (event.type === 'mcp.input.settled') {
          return [[event.type, event.status]];
        }
        return event.type.startsWith('mcp.input.') ? [[event.type]] : [];
      })
    ).toEqual([
      ['mcp.input.requested'],
      ['mcp.input.intent'],
      ['mcp.input.settled', 'remote-acknowledged'],
    ]);
    expect(JSON.stringify(log.rows())).not.toContain(presentation.message);
    expect(modern.finalized.items).toEqual([
      { code: 'mcp-elicitation-already-settled', id: presentation.id },
    ]);
    expect(modern.presentations.items).toEqual([]);
    expect(modern.inputs.items).toHaveLength(1);
    expect(diagnostics(modern)).toEqual([LEASE_UNAVAILABLE]);
  });

  it('withdraws pending server input when the task authority cancels the task and fences the late answer', async (context) => {
    const lab = await startLab('tasks-reference', context.signal);
    const modern = await openTasksHost(lab);
    const { log, runId } = await startThreadRun(modern, 'Start, then cancel the task');
    const input = await modern.inputs.until((items) => items[0]);
    const presentation = requirePresentation(input);
    const handle = requireTaskHandle(presentation);
    await expect(
      modern.services.runtime.taskHost.act({ action: 'cancel', handle })
    ).resolves.toEqual({
      ok: true,
      task: expect.objectContaining({ canCancel: false, handle, status: 'cancelled' }),
    });
    expect(modern.finalized.items).toEqual([
      { code: 'mcp-elicitation-caller-aborted', id: presentation.id },
    ]);
    // Core retired the input with its capability, so the late public answer is refused.
    await expectHostPrivateFailure(
      () => answerPublicly(modern.client, input.address, APPROVE),
      'mcp/input/stage'
    );
    await expect(modern.client.request('mcp/input/read', input.address)).resolves.toMatchObject({
      status: 'retired',
    });
    expect(await log.finished()).toMatchObject({ outcome: 'completed', runId });
    await expectCanonicalTask(modern, log.rows(), (await log.effect()).toolCallId, handle, [
      'working',
      'working',
      'input_required',
      'cancelled',
    ]);
    expect(modern.presentations.items).toEqual([]);
    expect(modern.inputs.items).toHaveLength(1);
    expect(diagnostics(modern)).toEqual([LEASE_UNAVAILABLE]);
  });

  it('delivers a refused server input over the transport without completing the task or asking again', async (context) => {
    const lab = await startLab('tasks-reference', context.signal);
    const modern = await openTasksHost(lab);
    const { log, runId } = await startThreadRun(modern, 'Start, then refuse the task');
    const input = await modern.inputs.until((items) => items[0]);
    const presentation = requirePresentation(input);
    const handle = requireTaskHandle(presentation);
    await expect(
      answerPublicly(modern.client, input.address, { action: 'decline' })
    ).resolves.toEqual({ accepted: true, status: 'accepted' });
    // Retry oracle updated with the causal evidence (#3543 6053865477, P1 6053022823): the lab
    // answers the one delivery with a JSON-RPC error, which proves no ack, not non-application,
    // so the next poll raises the visible unknown and nothing is sent or presented again.
    const failures = await modern.internalErrors.until((items) => {
      const consumer = items.filter(({ code }) => code === 'mcp-task-consumer-failed');
      return consumer.length >= 2 ? consumer : undefined;
    });
    expect(failures.slice(0, 2).map(({ cause }) => causeMessage(cause))).toEqual([
      expect.stringContaining(REFUSED),
      UNKNOWN,
    ]);
    // Core committed the uncertainty as the settlement outcome.
    expect(await log.until((rows) => eventOf(rows, 'mcp.input.settled'))).toMatchObject({
      interactionId: presentation.id,
      runId,
      status: 'unknown',
    });
    expect(await durableTask(modern.storage, handle)).toMatchObject({
      resultMetadata: null,
      status: 'input_required',
    });
    const { toolCallId } = await log.effect();
    expect(
      eventOf(log.rows(), 'effect.finished', (event) => event.toolCallId === toolCallId)
    ).toBeUndefined();
    expect(modern.presentations.items).toEqual([]);
    expect(modern.inputs.items).toEqual([input]);
    expect(modern.finalized.items).toEqual([
      { code: 'mcp-elicitation-already-settled', id: presentation.id },
    ]);
    await expect(
      modern.services.runtime.taskHost.act({ action: 'cancel', handle })
    ).resolves.toMatchObject({ ok: true, task: { handle, status: 'cancelled' } });
    expect(await log.finished()).toMatchObject({ outcome: 'completed', runId });
    const { history } = await durableTask(modern.storage, handle);
    const statuses = history.map(({ status }) => status);
    expect(statuses.slice(0, 3)).toEqual(['working', 'working', 'input_required']);
    expect(statuses.at(-1)).toBe('cancelled');
    await expectCanonicalTask(
      modern,
      log.rows(),
      (await log.effect()).toolCallId,
      handle,
      statuses
    );
  });

  it('runs one App tool with rich and text composition and keeps UI metadata away from the model', async (context) => {
    const lab = await startLab('apps-reference', context.signal);
    for (const appUi of ['rich', 'text'] as const) {
      const modern = await openModernHost({
        appUi,
        lab,
        policy: 'allow',
        serverId: APPS_SERVER,
        toolName: 'get-time',
      });
      const { log, runId } = await startThreadRun(modern, 'Ask the App for the time');
      expect(await log.finished()).toMatchObject({ outcome: 'completed', runId });
      expect(liveServer(modern.services)).toMatchObject({
        configuredServerId: APPS_SERVER,
        extensions: { apps: appUi === 'rich', tasks: true },
        negotiated: { revision: '2026-07-28' },
        state: 'connected',
      });
      const { toolCallId } = await log.effect();
      // The domain marker and ordinary result are committed in both compositions (BST-1604 gates
      // mounting on the snapshot, not the log); the provider sees only the result, no UI metadata.
      const marker = readMcpAppToolInvocationResult(
        eventOf(log.rows(), 'effect.finished', (event) => event.toolCallId === toolCallId)?.output
      );
      expect(marker).toEqual({
        app: {
          mimeType: APP_MIME_TYPE,
          resourceUri: APP_RESOURCE_URI,
          serverId: APPS_SERVER,
          toolName: 'get-time',
        },
        kind: 'mcp-app',
        result: { time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u) },
      });
      expect(modelToolResult(modern.model, toolCallId)).toEqual({
        type: 'text',
        value: JSON.stringify(marker?.result),
      });
      // Proven on the wire: the lab serves the App document only to an Apps-advertising client.
      const read = modern.services.mcp.authority.invoke({
        configuredServerId: parseConfiguredMcpServerId(APPS_SERVER),
        type: 'resources/read',
        uri: APP_RESOURCE_URI,
      });
      if (appUi === 'rich') {
        await expect(read).resolves.toMatchObject({
          result: {
            contents: [
              {
                mimeType: APP_MIME_TYPE,
                text: expect.stringContaining('<title>Get Time App</title>'),
                uri: APP_RESOURCE_URI,
              },
            ],
          },
          type: 'resources/read',
        });
        expect(diagnostics(modern)).toEqual([]);
      } else {
        await expect(read).rejects.toMatchObject({
          category: 'protocol',
          code: 'mcp-protocol-error',
          name: 'McpServerActorError',
        });
        expect(diagnostics(modern)).toEqual([
          [
            'mcp-protocol-error',
            expect.stringContaining(
              `MCP Apps reference resource ${APP_RESOURCE_URI} requires the io.modelcontextprotocol/ui host capability with ${APP_MIME_TYPE}`
            ),
          ],
        ]);
      }
      expect(modern.presentations.items).toEqual([]);
      expect(modern.inputs.items).toEqual([]);
    }
  });

  // The recovered answer must go through Core's public client (ruling C). RED until Studio's
  // recovered-task ownership seam exists (#3543 receipt): a reconstructed leaf has no Core
  // capability for a recovered task, so today it presents the input on the local listener.
  it('joins the admitted request, task activity, transport and lab process on Root shutdown, fences late events, and recovers the durable input after restart', async (context) => {
    const lab = await startLab('tasks-reference', context.signal);
    const first = await openTasksHost(lab);
    const { log, runId, threadId } = await startThreadRun(first, 'Start, then shut down');
    const input = await first.inputs.until((items) => items[0]);
    const presentation = requirePresentation(input);
    const handle = requireTaskHandle(presentation);
    const effect = await log.effect();
    await expect(first.client.request('host/stop', {})).resolves.toEqual({
      outcome: 'stopped',
      rootReleased: true,
    });
    await first.host.closed;
    // Root shutdown consumed this memoized receipt: one client and callback, tools/list and call.
    expect(await first.services.mcp.close()).toEqual({
      callbacksClosed: 1,
      childProcessesClosed: 0,
      clientsClosed: 1,
      failures: [],
      loopbackPortsClosed: 0,
      probesClosed: 0,
      requestsSettled: 2,
      subscriptionsClosed: 0,
    });
    // Root shutdown stops the run before the presenter closes: the BST-1930 fence withdraws input.
    expect(first.finalized.items).toEqual([
      { code: 'mcp-elicitation-caller-aborted', id: presentation.id },
    ]);
    expect(() => first.settleDirect(answerFor(presentation, 'accept'))).toThrow(
      expect.objectContaining({ code: 'mcp-elicitation-caller-aborted' })
    );
    expect(() => first.services.runtime.taskHost.subscribe(() => undefined)).toThrow(
      'MCP Tasks host is closed.'
    );
    // As an async admission caller observes it (the port fences synchronously).
    await expect(
      Promise.resolve().then(() => first.services.mcp.executableTools(fixtureToolRequest))
    ).rejects.toMatchObject({ code: 'agent_host_adapter_closed' });
    expect(await durableTask(first.storage, handle)).toMatchObject({
      ...handle,
      resultMetadata: null,
      status: 'input_required',
    });
    const fenced = (): unknown => ({
      errors: first.internalErrors.items.length,
      finalized: first.finalized.items.length,
      inputs: first.inputs.items.length,
      presentations: first.presentations.items.length,
    });
    const atShutdown = fenced();

    const second = await reopenAndRecover(first, lab, threadId);
    const reopened = (await second.client.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(eventOf(reopened, 'effect.started', (event) => event.toolId === effect.toolId)).toEqual(
      effect
    );
    expect(
      eventOf(reopened, 'effect.finished', (event) => event.toolCallId === effect.toolCallId)
    ).toBeUndefined();
    expect(eventOf(reopened, 'run.finished')).toMatchObject({ outcome: 'interrupted', runId });
    const recovered = await firstOf({
      local: second.presentations.until((items) => items[0]),
      public: second.inputs.until(requested),
    });
    expect(recovered.fact).toBe('public');
    const recoveredInput = await second.inputs.until(requested);
    expect(requirePresentation(recoveredInput)).toEqual(
      expectedTaskInput(liveServer(second.services).generation, { type: 'tools/call' }, handle)
    );
    const settled = new Observed<McpTaskPresentation>();
    const unsubscribe = second.services.runtime.taskHost.subscribe((task) => settled.push(task));
    owned.push(async () => unsubscribe());
    await answerPublicly(second.client, recoveredInput.address, APPROVE);
    expect(
      await settled.until((items) => items.find(({ status }) => status === 'completed'))
    ).toMatchObject({ handle, recovery: 'terminal', status: 'completed' });
    const record = await durableTask(second.storage, handle);
    expect(record).toMatchObject({
      ...handle,
      resultMetadata: { result: { content: [{ text: 'done', type: 'text' }] } },
      status: 'completed',
    });
    expect(record.history.map(({ status }) => status)).toEqual([
      'working',
      'working',
      'input_required',
      'input_required',
      'completed',
    ]);
    expect(await lab.close()).toEqual({
      exit: { code: 0, signal: null },
      pid: lab.ready.pid,
      report: { httpListenersClosed: 1, stdioTransportsClosed: 0, untriggeredFaultIds: [] },
      scenario: 'tasks-reference',
      start: lab.start,
      startAfterJoin: null,
    });
    expect(fenced()).toEqual(atShutdown);
    // Diagnostics of the joined cancellation, not cleanup failures (the receipt reports none):
    // Core's close reason ends the task wait, which withdraws its input before interaction close.
    expect(diagnostics(first)).toEqual([
      LEASE_UNAVAILABLE,
      ['mcp-task-settlement-failed', 'Host is closing'],
    ]);
  });

  // Formerly RED (#3543): the public protocol committed no answerable record of server input.
  // Per #3556 6049578135 it now requires the exact durable provenance and a real public
  // settlement with stale and duplicate controls; a message-bearing event alone cannot pass.
  it('commits server-originated task input where an attached public host client can answer it', async (context) => {
    const lab = await startLab('tasks-reference', context.signal);
    const modern = await openTasksHost(lab);
    const { log, runId } = await startThreadRun(modern, 'Start the task');
    const input = await modern.inputs.until((items) => items[0]);
    const presentation = requirePresentation(input);
    const effect = await log.effect();
    expect(eventOf(log.rows(), 'mcp.task.bound')).toMatchObject({
      configuredServerId: TASKS_SERVER,
      handle: requireTaskHandle(presentation),
      runId,
      toolCallId: effect.toolCallId,
      toolId: modern.toolId,
      toolIdentity: effect.toolIdentity,
    });
    expect(input.request).toEqual({
      configuredServerId: TASKS_SERVER,
      generation: presentation.provenance.generation,
      interactionId: presentation.id,
      invocationId: presentation.provenance.invocationId,
      mode: 'form',
      requestId: 'approval',
      runId,
      taskId: 'reference-task-1',
      toolCallId: effect.toolCallId,
      toolId: modern.toolId,
      toolIdentity: effect.toolIdentity,
      type: 'mcp.input.requested',
    });
    expect(input.status).toBe('requested');
    // Durable history carries only the safe envelope; the presentation came from the read.
    expect(JSON.stringify(log.rows())).not.toContain(presentation.message);
    await expectHostPrivateFailure(
      () =>
        answerPublicly(modern.client, { ...input.address, interactionId: randomUUID() }, APPROVE),
      'mcp/input/stage'
    );
    const commandId = randomUUID();
    await expect(answerPublicly(modern.client, input.address, APPROVE, commandId)).resolves.toEqual(
      { accepted: true, status: 'accepted' }
    );
    // The same command is idempotent; a second authorization is refused.
    await expect(
      modern.client.request('mcp/input/settle', { ...input.address, action: 'accept', commandId })
    ).resolves.toMatchObject({ accepted: true });
    await expectHostPrivateFailure(
      () => answerPublicly(modern.client, input.address, APPROVE),
      'mcp/input/stage'
    );
    expect(await log.finished()).toMatchObject({ outcome: 'completed', runId });
    expect(await log.until((rows) => eventOf(rows, 'mcp.input.settled'))).toMatchObject({
      interactionId: presentation.id,
      runId,
      status: 'remote-acknowledged',
    });
    expect(modern.presentations.items).toEqual([]);
  });

  // Green since #3543 fix 2: run/stop withdraws task-bound input and refuses a late answer.
  it('fences task-bound server input when the run that admitted it stops', async (context) => {
    const lab = await startLab('tasks-reference', context.signal);
    const first = await openTasksHost(lab);
    const { log, runId, threadId } = await startThreadRun(first, 'Start, then stop');
    const input = await first.inputs.until((items) => items[0]);
    const presentation = requirePresentation(input);
    const handle = requireTaskHandle(presentation);
    await expect(
      first.client.request('run/stop', { commandId: randomUUID(), runId, threadId })
    ).resolves.toEqual({ outcome: 'stopped' });
    expect(await log.finished()).toMatchObject({ outcome: 'stopped', runId });
    const finalizedAfterStop = [...first.finalized.items];
    await expectHostPrivateFailure(
      () => answerPublicly(first.client, input.address, APPROVE),
      'mcp/input/stage'
    );
    expect(finalizedAfterStop).toEqual([
      { code: expect.stringMatching(/^mcp-elicitation-/u), id: presentation.id },
    ]);
    await first.client.request('host/stop', {});
    await first.host.closed;
    // Nothing reached the server: a restarted host still recovers the input. The recovered answer
    // path is the restart case's oracle; this case only requires the recovery itself.
    const second = await reopenAndRecover(first, lab, threadId);
    const recovered = await firstOf({
      local: second.presentations.until((items) => items[0]?.provenance.taskHandle),
      public: second.inputs.until((items) => requested(items)?.presentation?.provenance.taskHandle),
    });
    expect(recovered.value).toEqual(handle);
  });

  // Green since #3543 fix 1: the persisted `input_required` is published before input parks.
  it('projects pending server input through the task authority while the server waits for it', async (context) => {
    const lab = await startLab('tasks-reference', context.signal);
    const modern = await openTasksHost(lab);
    const { log } = await startThreadRun(modern, 'Start the task');
    const input = await modern.inputs.until((items) => items[0]);
    const handle = requireTaskHandle(requirePresentation(input));
    const record = await durableTask(modern.storage, handle);
    expect(record).toMatchObject({
      ...handle,
      inputMetadata: {
        inputRequests: { approval: { method: 'elicitation/create', params: TASK_INPUT_REQUEST } },
      },
      status: 'input_required',
    });
    try {
      expect(modern.services.runtime.taskHost.list().tasks).toEqual([
        expect.objectContaining({
          handle,
          recovery: 'live',
          status: 'input_required',
          updatedAt: record.updatedAt.toISOString(),
        }),
      ]);
    } finally {
      await answerPublicly(modern.client, input.address, APPROVE);
      await log.finished();
    }
  });

  // Packet C finding (#3543 6055185569): a legacy push-style server input on a host run failed
  // with a generic `tool_failed` and no log line. The legacy lab fixture is stateless, so the
  // server keeps no negotiated client capabilities and refuses `elicitation/create` itself (MCP
  // 2025-11-25 basic/lifecycle L220; this client declares elicitation per client/elicitation L51).
  // That refusal is the server's `isError` result: nothing is presented, and its reason is typed
  // and logged at the MCP boundary instead of vanishing behind the run's tool guard.
  it("surfaces a stateless legacy server's push-style input refusal instead of failing silently", async (context) => {
    const records: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => records.push(record));
    owned.push(async () => removeLogListener());
    const lab = await startLab('legacy-reference', context.signal);
    const modern = await openModernHost({
      appUi: 'text',
      lab,
      policy: 'allow',
      protocol: 'legacy',
      serverId: LEGACY_SERVER,
      toolInput: { text: 'parity' },
      toolName: 'elicit_confirm',
    });
    const { log, runId } = await startThreadRun(modern, 'Confirm through the legacy server');
    expect(await log.finished()).toMatchObject({ runId });
    const { toolCallId } = await log.effect();
    expect(
      eventOf(log.rows(), 'effect.finished', (event) => event.toolCallId === toolCallId)
    ).toMatchObject({
      output: { error: { code: 'tool_failed', toolName: 'lab.legacy.elicit_confirm' }, ok: false },
    });
    expect(records).toContainEqual(
      expect.objectContaining({
        args: [
          'MCP tool returned an error result',
          {
            reason: 'Client does not support form elicitation.',
            serverName: LEGACY_SERVER,
            toolName: 'elicit_confirm',
          },
        ],
        level: 'warn',
      })
    );
    expect(modern.presentations.items).toEqual([]);
    expect(modern.inputs.items).toEqual([]);
  });

  // RED until Studio publishes a read of Core's committed outcome for a recovered task's input
  // (#3543 receipt). A reconstructed leaf must consult it before presenting or delivering: the
  // refusal's committed `unknown` must stay a visible unknown across a restart, never re-asked.
  it('keeps a committed unknown outcome fenced across a host restart', async (context) => {
    const lab = await startLab('tasks-reference', context.signal);
    const first = await openTasksHost(lab);
    const { log, threadId } = await startThreadRun(first, 'Start, then refuse the task');
    const input = await first.inputs.until((items) => items[0]);
    await answerPublicly(first.client, input.address, { action: 'decline' });
    expect(await log.until((rows) => eventOf(rows, 'mcp.input.settled'))).toMatchObject({
      status: 'unknown',
    });
    await first.client.request('host/stop', {});
    await first.host.closed;
    const second = await reopenAndRecover(first, lab, threadId);
    const outcome = await firstOf({
      local: second.presentations.until((items) => items[0]),
      public: second.inputs.until(requested),
      unknown: second.internalErrors.until((items) =>
        items.find(({ cause }) => causeMessage(cause) === UNKNOWN)
      ),
    });
    expect(outcome.fact).toBe('unknown');
    expect(second.presentations.items).toEqual([]);
    expect(requested(second.inputs.items)).toBeUndefined();
  });

  // By design only the Vitest test watchdog ends this case (#3543 6052105986); no fixture
  // deadline is added. Only its value is narrowed: the lab replies twice in well under a
  // second, so the watchdog still fires while join waits on the retained handle, and an
  // earlier firing fails the "2 replies" assertion below.
  const RETAINED_HANDLE_WATCHDOG_MS = 5000;
  const retained: { closed?: unknown; lab?: LabProcess } = {};
  it.fails('kills and joins a lab child that reports closed but keeps its IPC handle', {
    timeout: RETAINED_HANDLE_WATCHDOG_MS,
  }, async (context) => {
    retained.lab = await startLab('tasks-reference', context.signal, true);
    retained.closed = await retained.lab.close().catch((closed: unknown) => closed);
  });
  it('leaves no lab child after that watchdog and keeps its failures', () => {
    expect(processStartTime(retained.lab?.ready.pid ?? 0)).not.toBe(retained.lab?.start);
    expect(retained.closed).toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('timed out') }),
      message: expect.stringContaining('MCP lab cancelled after 2 replies'),
    });
  });
});
