import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from '@modelcontextprotocol/client/stdio';

export interface McpLabStdioParameters {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
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
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private delegate: StdioClientTransport | undefined;
  private spawned = false;
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((message: JSONRPCMessage) => void) | undefined;

  constructor(
    private readonly parameters: McpLabStdioParameters,
    private readonly recordStderrBytes: (byteCount: number) => void
  ) {}

  get pid(): number | null {
    return this.delegate?.pid ?? null;
  }

  get wasSpawned(): boolean {
    return this.spawned;
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error('MCP lab stdio transport is closed');
    }
    if (this.delegate) {
      throw new Error('MCP lab stdio transport is already started');
    }
    const delegate = new StdioClientTransport({
      args: [...this.parameters.args],
      command: this.parameters.command,
      cwd: this.parameters.cwd,
      env: suppressDefaultEnvironment(this.parameters.env),
      stderr: 'pipe',
    });
    delegate.onclose = () => {
      this.closed = true;
      this.onclose?.();
    };
    delegate.onerror = (error) => this.onerror?.(error);
    delegate.onmessage = (message) => this.onmessage?.(message);
    delegate.stderr?.on('data', (chunk: unknown) => this.recordStderrBytes(chunkByteLength(chunk)));
    this.delegate = delegate;
    await delegate.start();
    this.spawned = true;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    const delegate = this.delegate;
    if (!delegate) {
      this.closed = true;
      return;
    }
    this.closePromise = delegate.close().then(
      () => {
        this.closed = true;
      },
      (error: unknown) => {
        this.closePromise = undefined;
        throw error;
      }
    );
    return this.closePromise;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.delegate) {
      throw new Error('MCP lab stdio transport is not started');
    }
    await this.delegate.send(message);
  }
}
