import {
  decodeMcpRuntimeError,
  MCP_RUNTIME_METHODS,
  type McpToolRegistryState,
  McpToolRegistryStateSchema,
} from '@brainstrike/host-capabilities/mcp/mcp-runtime-wire';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';

/** The Node host is not running (or not yet ready), so no MCP request can be served. */
export class McpRuntimeUnavailableError extends Error {
  readonly category = 'transport' as const;
  readonly code = 'mcp-runtime-unavailable';
  constructor() {
    super('MCP is unavailable: the agent host is not running.');
    this.name = 'McpRuntimeUnavailableError';
  }
}

/**
 * Main's requests to the agent host's MCP settings (BST-1930 c5e): the native
 * picker's chosen config file, the factory reset's retire and reopen, and the
 * tool enablement persona availability reads. The host owns the runtime, its
 * status, tools and settings; Main keeps no copy of any of them.
 */
export class MainMcpHostControl {
  #closed = false;
  #ready: MessageConnection | undefined;

  /** Main's native picker chose an MCP config file: the host selects it. */
  async pickConfigPath(path: string): Promise<{ readonly path: string; readonly success: true }> {
    return Schema.decodeUnknownSync(
      Schema.Struct({ path: Schema.String, success: Schema.Literal(true) }),
      { onExcessProperty: 'error' }
    )(await this.#call(MCP_RUNTIME_METHODS.configPathPick, { path }));
  }

  /** Factory reset: the host retires its MCP settings lifecycle and keeps a restore point. */
  async resetSettings(): Promise<void> {
    await this.#call(MCP_RUNTIME_METHODS.settingsReset, {});
  }

  /** After a factory reset: the host reopens its MCP settings, restoring them if it failed. */
  async resumeSettings(outcome: 'failed' | 'succeeded'): Promise<void> {
    await this.#call(MCP_RUNTIME_METHODS.settingsResume, { outcome });
  }

  /** The host's MCP tools, read once for the caller. */
  async readTools(): Promise<McpToolRegistryState> {
    return Schema.decodeUnknownSync(McpToolRegistryStateSchema)(
      await this.#call(MCP_RUNTIME_METHODS.toolsRead, {})
    );
  }

  /** Main's shutdown: no further request reaches the host. */
  close(): void {
    this.#closed = true;
    this.#ready = undefined;
  }

  /** Bind one Node host connection; requests flow once Node reports `ready()`. */
  bind(connection: MessageConnection): { close(): void; ready(): void } {
    let bound = true;
    return {
      close: () => {
        bound = false;
        if (this.#ready === connection) {
          this.#ready = undefined;
        }
      },
      ready: () => {
        if (!bound || this.#closed) {
          throw new McpRuntimeUnavailableError();
        }
        this.#ready = connection;
      },
    };
  }

  async #call(method: string, params: unknown): Promise<unknown> {
    const connection = this.#ready;
    if (!connection) {
      throw new McpRuntimeUnavailableError();
    }
    try {
      return await connection.sendRequest(method, params);
    } catch (cause) {
      throw decodeMcpRuntimeError(cause);
    }
  }
}

let singleton: MainMcpHostControl | undefined;
/** Main's one MCP host control, bound to the forked agent host's connection. */
export const getMainMcpHostControl = (): MainMcpHostControl =>
  (singleton ??= new MainMcpHostControl());
