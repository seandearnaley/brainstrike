import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from '@modelcontextprotocol/client/stdio';
import type { McpLabFaultRuntime } from './fault-runtime.js';
import type { McpLabProtocolEra } from './faults.js';
import { McpLabStdioChildFaults } from './stdio-child-faults.js';
import { McpLabStdioProtocolFaults } from './stdio-protocol-faults.js';

export interface McpLabStdioParameters {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly era: McpLabProtocolEra;
}

function chunkByteLength(chunk: unknown): number {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk);
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.length;
  }
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }
  return Buffer.byteLength(String(chunk));
}

function suppressDefaultEnvironment(
  environment: Readonly<Record<string, string>>
): Record<string, string> {
  const suppressed: Record<string, string | undefined> = { ...environment };
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    suppressed[key] = undefined;
  }
  return suppressed as unknown as Record<string, string>;
}

export class McpLabOwnedStdioTransport implements Transport {
  private readonly activeSends = new Set<Promise<void>>();
  private readonly childFaults: McpLabStdioChildFaults;
  private readonly sendAborters = new Set<(error: Error) => void>();
  private readonly protocolFaults: McpLabStdioProtocolFaults;
  private capturedPid: number | null = null;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private closing = false;
  private delegate: StdioClientTransport | undefined;
  private delegateClosePromise: Promise<void> | undefined;
  private receivedMessage = false;
  private spawned = false;
  private spawnedPid: number | null = null;
  private startPromise: Promise<void> | undefined;
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((message: JSONRPCMessage) => void) | undefined;

  constructor(
    private readonly parameters: McpLabStdioParameters,
    private readonly recordStderrBytes: (byteCount: number) => void,
    faultRuntime: McpLabFaultRuntime
  ) {
    this.childFaults = new McpLabStdioChildFaults(faultRuntime);
    this.protocolFaults = new McpLabStdioProtocolFaults(faultRuntime, parameters.era);
  }

  get pid(): number | null {
    return this.spawnedPid;
  }

  get lastSpawnedPid(): number | null {
    return this.capturedPid;
  }

  get wasSpawned(): boolean {
    return this.spawned;
  }

  start(): Promise<void> {
    if (this.closed || this.closing) {
      return Promise.reject(new Error('MCP lab stdio transport is closed'));
    }
    if (this.startPromise) {
      return Promise.reject(new Error('MCP lab stdio transport is already started'));
    }
    const starting = this.startOnce();
    this.startPromise = starting;
    return starting;
  }

  private async startOnce(): Promise<void> {
    let delegate: StdioClientTransport | undefined;
    try {
      await this.childFaults.beforeSpawn();
      if (this.closing) {
        throw new Error('MCP lab stdio transport closed during startup');
      }
      const args = await this.childFaults.args(this.parameters.args);
      if (this.closing) {
        throw new Error('MCP lab stdio transport closed during startup');
      }
      delegate = new StdioClientTransport({
        args: [...args],
        command: this.parameters.command,
        cwd: this.parameters.cwd,
        env: suppressDefaultEnvironment(this.parameters.env),
        stderr: 'pipe',
      });
      delegate.onclose = () => {
        this.closing = true;
        void this.finishDelegateClose();
      };
      delegate.onerror = (error) => this.onerror?.(error);
      delegate.onmessage = (message) => {
        this.receivedMessage = true;
        this.protocolFaults.receive(message, () => this.onmessage?.(message));
      };
      delegate.stderr?.on('data', (chunk: unknown) =>
        this.recordStderrBytes(chunkByteLength(chunk))
      );
      this.delegate = delegate;
      await delegate.start();
      this.spawned = true;
      this.spawnedPid = delegate.pid;
      this.capturedPid = this.spawnedPid;
      if (this.spawnedPid === null) {
        throw new Error('MCP lab stdio transport started without a child pid');
      }
      await this.childFaults.afterSpawn();
    } catch {
      if (delegate) {
        try {
          await delegate.close();
        } catch {
          // The public startup error below is deliberately fixed-shape.
        }
      }
      try {
        await this.childFaults.close(this.spawnedPid);
      } catch {
        // The public startup error below is deliberately fixed-shape.
      }
      throw new Error('MCP lab stdio transport failed to start');
    }
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closing = true;
    this.closePromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      let cleanupFailed = false;
      const delegate = this.delegate;
      const closingError = new Error('MCP lab stdio transport closed during send');
      for (const abort of this.sendAborters) {
        abort(closingError);
      }
      this.sendAborters.clear();
      try {
        await delegate?.close();
      } catch {
        cleanupFailed = true;
      }
      try {
        await this.protocolFaults.close();
      } catch {
        cleanupFailed = true;
      }
      await this.waitForActiveSends();
      this.protocolFaults.finishClose();
      try {
        const pid = this.spawnedPid;
        await this.childFaults.close(pid, () => pid !== null && delegate?.pid === pid);
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        this.closePromise = undefined;
        throw new Error('MCP lab stdio transport cleanup failed');
      }
      this.closed = true;
      this.spawnedPid = null;
    })();
    return this.closePromise;
  }

  send(message: JSONRPCMessage): Promise<void> {
    const delegate = this.delegate;
    if (this.closing || !delegate) {
      return Promise.reject(new Error('MCP lab stdio transport is not started'));
    }
    const sending = this.sendOnce(message, delegate);
    this.activeSends.add(sending);
    void sending.finally(() => this.activeSends.delete(sending)).catch(() => undefined);
    return sending;
  }

  private finishDelegateClose(): Promise<void> {
    if (this.delegateClosePromise) {
      return this.delegateClosePromise;
    }
    this.delegateClosePromise = (async () => {
      await this.waitForActiveSends();
      this.closed = true;
      this.onclose?.();
    })();
    return this.delegateClosePromise;
  }

  private async sendOnce(message: JSONRPCMessage, delegate: StdioClientTransport): Promise<void> {
    const { promise: aborted, reject: abort } = Promise.withResolvers<void>();
    void aborted.catch(() => undefined);
    this.sendAborters.add(abort);
    try {
      await this.protocolFaults.send(message, () =>
        Promise.race([aborted, delegate.send(message)])
      );
    } finally {
      this.sendAborters.delete(abort);
    }
    if (this.spawnedPid !== null) {
      const pid = this.spawnedPid;
      await this.childFaults.afterSend(pid, () => delegate.pid === pid, this.receivedMessage);
    }
  }

  private async waitForActiveSends(): Promise<void> {
    await Promise.all([...this.activeSends].map((sending) => sending.catch(() => undefined)));
  }
}
