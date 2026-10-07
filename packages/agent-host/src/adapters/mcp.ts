import {
  type ConfiguredMcpServerId,
  type McpHostPort,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import type { HostTool, HostToolContext } from '../ports.js';

/** Executable bindings from the existing Node MCP authority, never discovery metadata. */
export interface McpHostToolBinding {
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly generation: number;
  /**
   * The authority supplies its exact executor identity, validated schema and
   * complete Tasks/Apps result path. This adapter does not convert JSON Schema,
   * project results, poll tasks, or construct an MCP client.
   */
  readonly tool: HostTool;
}

export interface McpHostToolAdapterOptions {
  /** Keys are the authority's admitted tool IDs, not names parsed for routing. */
  readonly bindings: Readonly<Record<string, McpHostToolBinding>>;
  readonly host: Pick<McpHostPort, 'snapshot' | 'watch'>;
}

export interface McpHostToolAdapter {
  /** Abort and join borrowed executions, then release their watches. */
  close(): Promise<void>;
  readonly tools: Readonly<Record<string, HostTool>>;
}

export class McpHostToolRetiredError extends Error {
  readonly category = 'generation-retired';

  constructor() {
    super('MCP host tool authority generation or executor retired');
    this.name = 'McpHostToolRetiredError';
  }
}

interface ServerLease {
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly controller: AbortController;
  readonly generation: number;
  readonly retired: McpHostToolRetiredError;
  unwatch?: () => void;
}

/**
 * Adapt the authority's executable entries without another registry or gate.
 * The platform owner still closes the MCP authority and verifies its physical
 * close report. This borrowed adapter never closes that shared authority.
 */
export function createMcpHostToolAdapter(options: McpHostToolAdapterOptions): McpHostToolAdapter {
  const controller = new AbortController();
  const closed = new Error('MCP host tool adapter is closed');
  const leases = new Map<ConfiguredMcpServerId, ServerLease>();
  const pending = new Set<Promise<unknown>>();
  let closePromise: Promise<void> | undefined;

  const refresh = (lease: ServerLease): void => {
    if (controller.signal.aborted || lease.controller.signal.aborted) {
      return;
    }
    try {
      const current = options.host
        .snapshot()
        .servers.find((server) => server.configuredServerId === lease.configuredServerId);
      if (current?.generation !== lease.generation) {
        lease.controller.abort(lease.retired);
      }
    } catch (cause) {
      lease.controller.abort(cause);
    }
  };

  const releaseWatches = (): unknown[] => {
    const failures: unknown[] = [];
    for (const lease of leases.values()) {
      try {
        lease.unwatch?.();
      } catch (cause) {
        failures.push(cause);
      }
    }
    return failures;
  };

  const entries = Object.entries(options.bindings);
  const retain = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    const settled = (): void => {
      pending.delete(work);
    };
    work.then(settled, settled);
    return work;
  };
  const acquisitionFailed = (cause: unknown): never => {
    controller.abort(cause);
    const failures = releaseWatches();
    if (failures.length > 0) {
      throw new AggregateError(
        [cause, ...failures],
        'MCP host tool acquisition and cleanup failed'
      );
    }
    throw cause;
  };
  try {
    // Validate every binding before acquiring any watch. Configured server IDs
    // and generations come from the authority, never from a dotted tool ID.
    for (const [, binding] of entries) {
      const configuredServerId = parseConfiguredMcpServerId(binding.configuredServerId);
      if (!(Number.isSafeInteger(binding.generation) && binding.generation > 0)) {
        throw new TypeError('MCP host tool binding requires a positive safe generation');
      }
      const existing = leases.get(configuredServerId);
      if (existing && existing.generation !== binding.generation) {
        throw new TypeError('MCP host tool bindings mix generations for one server');
      }
      if (!existing) {
        leases.set(configuredServerId, {
          configuredServerId,
          controller: new AbortController(),
          generation: binding.generation,
          retired: new McpHostToolRetiredError(),
        });
      }
    }
    for (const lease of leases.values()) {
      lease.unwatch = options.host.watch({ configuredServerIds: [lease.configuredServerId] }, () =>
        refresh(lease)
      );
      refresh(lease);
      lease.controller.signal.throwIfAborted();
    }
  } catch (cause) {
    acquisitionFailed(cause);
  }

  const tools = ((): Readonly<Record<string, HostTool>> => {
    try {
      return Object.freeze(
        Object.fromEntries(
          entries.map(([toolId, binding]): [string, HostTool] => {
            const source = binding.tool;
            const {
              description,
              execute,
              identity,
              inputSchema,
              mcpAuthority,
              permissionToolId,
              reconstructApprovalInput,
              risk,
              strict,
              toModelOutput,
            } = source;
            const lease = leases.get(binding.configuredServerId);
            if (!lease) {
              throw new Error('MCP host tool binding has no acquired server lease');
            }
            const tool: HostTool = Object.freeze({
              description,
              ...(mcpAuthority ? { mcpAuthority } : {}),
              execute(input: unknown, context: HostToolContext): Promise<unknown> {
                const signal = AbortSignal.any([
                  context.signal,
                  controller.signal,
                  lease.controller.signal,
                ]);
                // Register before the executor's first side effect, including a
                // synchronous callback that starts adapter shutdown.
                const work = Promise.resolve().then(async () => {
                  signal.throwIfAborted();
                  refresh(lease);
                  signal.throwIfAborted();
                  if (source.identity !== identity || source.execute !== execute) {
                    throw lease.retired;
                  }
                  const output = await execute.call(source, input, { ...context, signal });
                  signal.throwIfAborted();
                  return output;
                });
                return retain(work);
              },
              identity,
              inputSchema,
              risk,
              ...(permissionToolId === undefined ? {} : { permissionToolId }),
              ...(reconstructApprovalInput
                ? {
                    reconstructApprovalInput(input: unknown): Promise<unknown> {
                      return retain(
                        Promise.resolve().then(async () => {
                          controller.signal.throwIfAborted();
                          refresh(lease);
                          lease.controller.signal.throwIfAborted();
                          if (
                            source.identity !== identity ||
                            source.reconstructApprovalInput !== reconstructApprovalInput
                          ) {
                            throw lease.retired;
                          }
                          const value = await reconstructApprovalInput.call(source, input);
                          controller.signal.throwIfAborted();
                          refresh(lease);
                          lease.controller.signal.throwIfAborted();
                          return value;
                        })
                      );
                    },
                  }
                : {}),
              ...(strict === undefined ? {} : { strict }),
              ...(toModelOutput ? { toModelOutput } : {}),
            });
            return [toolId, tool];
          })
        )
      );
    } catch (cause) {
      return acquisitionFailed(cause);
    }
  })();

  return Object.freeze({
    close(): Promise<void> {
      if (closePromise) {
        return closePromise;
      }
      const completion = Promise.withResolvers<void>();
      closePromise = completion.promise;
      controller.abort(closed);
      // Keep watches until executions settle, so release means the borrowed
      // work has actually returned. No cancellation-versus-work race is used.
      void Promise.allSettled([...pending]).then(() => {
        const failures = releaseWatches();
        if (failures.length === 1) {
          completion.reject(failures[0]);
        } else if (failures.length > 1) {
          completion.reject(new AggregateError(failures, 'MCP host tool watch cleanup failed'));
        } else {
          completion.resolve();
        }
      });
      return closePromise;
    },
    tools,
  });
}
