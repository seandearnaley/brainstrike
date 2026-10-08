import {
  ElicitRequestFormParamsSchema,
  ElicitRequestURLParamsSchema,
} from '@brainstrike/agent/mcp-client';
import type {
  HostMcpExecution,
  HostMcpInputCapability,
  HostMcpTaskCapability,
  HostToolContext,
} from '@brainstrike/agent-host';
import {
  ConfiguredMcpServerIdSchema,
  McpConfiguredProtocolSchema,
  type McpElicitationPresentationWire,
  McpStatusTransportSchema,
  McpTaskHandleSchema,
  parseMcpElicitationSettlement,
} from '@brainstrike/assistant-contract';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';

const Id = z.string().min(1);
const OriginSchema = z.strictObject({ runId: Id, threadId: Id, toolCallId: Id, toolId: Id });
type Origin = z.output<typeof OriginSchema>;
const ProvenanceSchema = z.strictObject({
  configuredProtocol: McpConfiguredProtocolSchema,
  configuredServerId: ConfiguredMcpServerIdSchema,
  generation: z.number().int().positive().safe(),
  invocationId: Id,
  negotiatedRevision: Id,
  operation: z.strictObject({
    target: z.string().optional(),
    type: z.enum([
      'tools/list',
      'tools/call',
      'resources/list',
      'resources/templates/list',
      'resources/read',
      'prompts/list',
      'prompts/get',
      'completion/complete',
      'resources/subscribe',
      'resources/unsubscribe',
    ]),
  }),
  requestId: z.union([Id, z.number().int().safe()]),
  serverIdentity: z
    .strictObject({
      name: Id,
      title: Id.optional(),
      version: z.string(),
      websiteOrigin: z.string().optional(),
    })
    .optional(),
  taskHandle: McpTaskHandleSchema.optional(),
  transport: McpStatusTransportSchema,
});
const PresentationBase = {
  id: Id,
  message: ElicitRequestFormParamsSchema.shape.message,
  provenance: ProvenanceSchema,
};
const PresentationSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...PresentationBase,
    mode: z.literal('form'),
    requestedSchema: ElicitRequestFormParamsSchema.shape.requestedSchema,
  }),
  z.strictObject({
    ...PresentationBase,
    mode: z.literal('url'),
    url: ElicitRequestURLParamsSchema.shape.url,
  }),
]);
const InputRequestSchema = z.strictObject({
  origin: OriginSchema,
  presentation: PresentationSchema,
});
const InputAddressSchema = z.strictObject({ id: Id, origin: OriginSchema });
const TaskAddressSchema = z.strictObject({ handle: McpTaskHandleSchema, origin: OriginSchema });
const AnswerSchema = z.strictObject({ answer: z.json(), id: Id, origin: OriginSchema });
const ReceiptSchema = z.enum(['local-finalized', 'remote-acknowledged']);
const CurrentSchema = z.strictObject({ current: z.literal(true) });

function refused(): Error {
  return new Error('Private MCP execution authority is unavailable or stale');
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw refused();
  }
  return result.data;
}
function sameOrigin(left: Origin, right: Origin): boolean {
  return (
    left.runId === right.runId &&
    left.threadId === right.threadId &&
    left.toolCallId === right.toolCallId &&
    left.toolId === right.toolId
  );
}
function parsePresentation(input: unknown): McpElicitationPresentationWire {
  const parsed = parse(PresentationSchema, input);
  const { operation, serverIdentity, taskHandle, ...provenance } = parsed.provenance;
  return {
    ...parsed,
    provenance: {
      ...provenance,
      operation: {
        type: operation.type,
        ...(operation.target === undefined ? {} : { target: operation.target }),
      },
      ...(taskHandle === undefined ? {} : { taskHandle }),
      ...(serverIdentity === undefined
        ? {}
        : {
            serverIdentity: {
              name: serverIdentity.name,
              version: serverIdentity.version,
              ...(serverIdentity.title === undefined ? {} : { title: serverIdentity.title }),
              ...(serverIdentity.websiteOrigin === undefined
                ? {}
                : { websiteOrigin: serverIdentity.websiteOrigin }),
            },
          }),
    },
  };
}
function executionAddress(origin: Origin): string {
  return JSON.stringify([origin.runId, origin.toolCallId]);
}
function taskAddress(handle: z.output<typeof McpTaskHandleSchema>): string {
  return JSON.stringify([
    handle.authorityEpoch,
    handle.principalId,
    handle.resource,
    handle.serverId,
    handle.taskId,
  ]);
}

/** Trusted reverse RPC stays on the existing private Main↔Node capability transport. */
export function bindNodeMcpPlatformTransport(
  connection: MessageConnection,
  lookup: (origin: Origin) => HostToolContext | undefined
): { release(origin: Origin): void; close(): void } {
  const inputs = new Map<
    string,
    { readonly origin: Origin; readonly controller: AbortController }
  >();
  const context = (origin: Origin): HostToolContext & { readonly mcp: HostMcpExecution } => {
    const value = lookup(origin);
    if (!value?.mcp || value.signal.aborted) {
      throw refused();
    }
    return { ...value, mcp: value.mcp };
  };
  const current = async (method: string, input: unknown): Promise<void> => {
    parse(CurrentSchema, await connection.sendRequest(method, input));
  };
  const handlers = [
    connection.onRequest('platform/mcp/task/bind', async (input: unknown) => {
      const request = parse(TaskAddressSchema, input);
      const execution = context(request.origin);
      await execution.mcp.bindTask({
        assertCurrent: () => current('platform/mcp/task/current', request),
        handle: request.handle,
      });
    }),
    connection.onRequest('platform/mcp/input/request', async (input: unknown) => {
      const request = parse(InputRequestSchema, input);
      const presentation = parsePresentation(request.presentation);
      const execution = context(request.origin);
      const id = presentation.id;
      if (inputs.has(id)) {
        throw refused();
      }
      const controller = new AbortController();
      inputs.set(id, { controller, origin: request.origin });
      const address = { id, origin: request.origin };
      try {
        await execution.mcp.requestInput({
          assertCurrent: () => current('platform/mcp/input/current', address),
          presentation,
          settle: async (answer) =>
            parse(
              ReceiptSchema,
              await connection.sendRequest('platform/mcp/input/settle', { ...address, answer })
            ),
          signal: AbortSignal.any([execution.signal, controller.signal]),
          validate: async (answer) => {
            await connection.sendRequest('platform/mcp/input/validate', { ...address, answer });
          },
        });
      } catch {
        inputs.delete(id);
        controller.abort(refused());
        throw refused();
      }
    }),
    connection.onRequest('platform/mcp/input/retire', (input: unknown) => {
      const request = parse(InputAddressSchema, input);
      context(request.origin);
      const owned = inputs.get(request.id);
      if (!(owned && sameOrigin(owned.origin, request.origin))) {
        throw refused();
      }
      inputs.delete(request.id);
      owned.controller.abort(refused());
    }),
  ];
  const release = (origin: Origin): void => {
    for (const [id, owned] of inputs) {
      if (sameOrigin(owned.origin, origin)) {
        inputs.delete(id);
        owned.controller.abort(refused());
      }
    }
  };
  return {
    close: () => {
      for (const owned of inputs.values()) {
        owned.controller.abort(refused());
      }
      inputs.clear();
      for (const handler of handlers) {
        handler.dispose();
      }
    },
    release,
  };
}

interface MainInput {
  readonly capability: HostMcpInputCapability;
  readonly origin: Origin;
  release(): void;
}
interface MainTask {
  readonly capability: HostMcpTaskCapability;
  readonly origin: Origin;
}
export function serveMainMcpPlatformTransport(
  connection: MessageConnection,
  retain: (work: Promise<unknown>) => void
): {
  execution(origin: Origin, signal: AbortSignal): HostMcpExecution;
  release(origin: Origin): void;
  close(): void;
} {
  const inputs = new Map<string, MainInput>();
  const tasks = new Map<string, MainTask>();
  const active = new Map<string, { readonly origin: Origin; readonly signal: AbortSignal }>();
  const check = (origin: Origin): void => {
    const execution = active.get(executionAddress(origin));
    if (!(execution && sameOrigin(execution.origin, origin)) || execution.signal.aborted) {
      throw refused();
    }
  };
  const getInput = (origin: Origin, id: string): MainInput => {
    check(origin);
    const input = inputs.get(id);
    if (!(input && sameOrigin(input.origin, origin)) || input.capability.signal.aborted) {
      throw refused();
    }
    return input;
  };
  const handlers = [
    connection.onRequest('platform/mcp/task/current', async (input: unknown) => {
      const request = parse(TaskAddressSchema, input);
      check(request.origin);
      const owned = tasks.get(taskAddress(request.handle));
      if (!(owned && sameOrigin(owned.origin, request.origin))) {
        throw refused();
      }
      try {
        await owned.capability.assertCurrent();
      } catch {
        throw refused();
      }
      check(request.origin);
      return { current: true };
    }),
    connection.onRequest('platform/mcp/input/current', async (input: unknown) => {
      const request = parse(InputAddressSchema, input);
      const owned = getInput(request.origin, request.id);
      try {
        await owned.capability.assertCurrent();
      } catch {
        throw refused();
      }
      getInput(request.origin, request.id);
      return { current: true };
    }),
    ...(['validate', 'settle'] as const).map((method) =>
      connection.onRequest(
        `platform/mcp/input/${method}`,
        async (input: unknown): Promise<unknown> => {
          const request = parse(AnswerSchema, input);
          const owned = getInput(request.origin, request.id);
          let answer: ReturnType<typeof parseMcpElicitationSettlement>;
          try {
            answer = parseMcpElicitationSettlement(request.answer);
          } catch {
            throw refused();
          }
          if (answer.id !== request.id) {
            throw refused();
          }
          try {
            await owned.capability.assertCurrent();
            getInput(request.origin, request.id);
            if (method === 'validate') {
              await owned.capability.validate(answer);
              return;
            }
            try {
              return parse(ReceiptSchema, await owned.capability.settle(answer));
            } finally {
              owned.release();
              inputs.delete(request.id);
            }
          } catch {
            throw refused();
          }
        }
      )
    ),
  ];
  const release = (origin: Origin): void => {
    active.delete(executionAddress(origin));
    for (const [id, owned] of inputs) {
      if (sameOrigin(owned.origin, origin)) {
        owned.release();
        inputs.delete(id);
      }
    }
    for (const [id, owned] of tasks) {
      if (sameOrigin(owned.origin, origin)) {
        tasks.delete(id);
      }
    }
  };
  return {
    close: () => {
      for (const owned of inputs.values()) {
        owned.release();
      }
      inputs.clear();
      tasks.clear();
      active.clear();
      for (const handler of handlers) {
        handler.dispose();
      }
    },
    execution: (origin, signal) => {
      const address = executionAddress(origin);
      if (active.has(address)) {
        throw refused();
      }
      active.set(address, { origin, signal });
      return {
        bindTask: async (capability) => {
          check(origin);
          const handle = parse(McpTaskHandleSchema, capability.handle);
          const key = taskAddress(handle);
          if (tasks.has(key)) {
            throw refused();
          }
          tasks.set(key, { capability, origin });
          try {
            await connection.sendRequest('platform/mcp/task/bind', { handle, origin });
          } catch {
            tasks.delete(key);
            throw refused();
          }
          check(origin);
        },
        requestInput: async (capability) => {
          check(origin);
          const presentation = parse(PresentationSchema, capability.presentation);
          if (inputs.has(presentation.id)) {
            throw refused();
          }
          const retire = (): void => {
            retain(
              connection
                .sendRequest('platform/mcp/input/retire', { id: presentation.id, origin })
                .catch(() => undefined)
            );
          };
          const releaseInput = (): void => capability.signal.removeEventListener('abort', retire);
          inputs.set(presentation.id, { capability, origin, release: releaseInput });
          capability.signal.addEventListener('abort', retire, { once: true });
          try {
            await connection.sendRequest('platform/mcp/input/request', { origin, presentation });
            check(origin);
            if (capability.signal.aborted) {
              throw refused();
            }
          } catch {
            releaseInput();
            inputs.delete(presentation.id);
            throw refused();
          }
        },
      };
    },
    release,
  };
}
