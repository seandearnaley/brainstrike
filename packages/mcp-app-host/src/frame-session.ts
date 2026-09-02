import { parsePositiveSafeInteger, toError } from './internal.js';

const OPAQUE_FRAME_ORIGIN = 'null';

export type McpAppFrameSessionPhase =
  | 'accepting-initialized'
  | 'awaiting-initialize'
  | 'awaiting-initialized'
  | 'closed'
  | 'disconnected'
  | 'initializing'
  | 'ready';

interface McpAppFrameMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

type McpAppFrameMessageListener = (event: McpAppFrameMessageEvent) => void;

export interface McpAppFrameEventTarget {
  addEventListener(type: 'message', listener: McpAppFrameMessageListener): void;
  removeEventListener(type: 'message', listener: McpAppFrameMessageListener): void;
}

export interface McpAppFrameSource {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface McpAppFrameBinding {
  readonly generation: number;
  readonly origin: 'null';
  readonly source: McpAppFrameSource;
}

export interface McpAppFrameSessionSnapshot {
  readonly generation?: number;
  readonly listenerCount: number;
  readonly phase: McpAppFrameSessionPhase;
}

export interface McpAppFrameSessionClaim {
  complete(): void;
  fail(error: Error): void;
  readonly generation: number;
  readonly kind: 'initialize' | 'initialized' | 'normal';
}

export interface McpAppFrameSessionMessageContext {
  claim(
    message: Readonly<{ kind: 'notification' | 'request'; method: string }>
  ): McpAppFrameSessionClaim;
  readonly generation: number;
}

export interface McpAppFrameSessionOptions {
  readonly eventTarget: McpAppFrameEventTarget;
  readonly isGenerationLive: (generation: number) => boolean;
  readonly onMessage: (value: unknown, context: McpAppFrameSessionMessageContext) => void;
  readonly onProtocolError: (error: Error) => void;
  readonly onTeardown: (reason: Error) => void;
}

export class McpAppFrameSession {
  readonly #eventTarget: McpAppFrameEventTarget;
  #frame: McpAppFrameBinding | undefined;
  #highestConnectedGeneration: number | undefined;
  readonly #isGenerationLive: (generation: number) => boolean;
  #listening = false;
  readonly #listener: McpAppFrameMessageListener;
  readonly #onMessage: McpAppFrameSessionOptions['onMessage'];
  readonly #onProtocolError: McpAppFrameSessionOptions['onProtocolError'];
  readonly #onTeardown: McpAppFrameSessionOptions['onTeardown'];
  #phase: McpAppFrameSessionPhase = 'disconnected';
  readonly #usedSources = new WeakSet<McpAppFrameSource>();

  constructor(options: McpAppFrameSessionOptions) {
    this.#eventTarget = options.eventTarget;
    this.#isGenerationLive = options.isGenerationLive;
    this.#onMessage = options.onMessage;
    this.#onProtocolError = options.onProtocolError;
    this.#onTeardown = options.onTeardown;
    this.#listener = (event) => this.#receive(event);
  }

  get snapshot(): McpAppFrameSessionSnapshot {
    return Object.freeze({
      ...(this.#frame === undefined ? {} : { generation: this.#frame.generation }),
      listenerCount: this.#listening ? 1 : 0,
      phase: this.#phase,
    });
  }

  connect(binding: McpAppFrameBinding): void {
    if (this.#phase === 'closed') {
      throw new TypeError('MCP Apps frame session is closed');
    }
    if (this.#phase !== 'disconnected') {
      throw new TypeError('MCP Apps frame session is already connected');
    }
    const parsed = this.#parseBinding(binding);
    if (!this.#isGenerationLive(parsed.generation)) {
      throw new TypeError('MCP Apps frame generation is not live');
    }
    this.#assertFreshBinding(parsed);
    try {
      this.#eventTarget.addEventListener('message', this.#listener);
      this.#listening = true;
      this.#frame = parsed;
      this.#highestConnectedGeneration = parsed.generation;
      this.#phase = 'awaiting-initialize';
      this.#usedSources.add(parsed.source);
    } catch (error: unknown) {
      this.#frame = undefined;
      this.#phase = 'disconnected';
      throw error;
    }
  }

  replace(binding: McpAppFrameBinding): void {
    if (this.#phase === 'closed') {
      throw new TypeError('MCP Apps frame session is closed');
    }
    const previousGeneration = this.#frame?.generation;
    const parsed = this.#parseBinding(binding);
    if (previousGeneration !== undefined && parsed.generation <= previousGeneration) {
      throw new TypeError('MCP Apps replacement frame generation must increase');
    }
    if (!this.#isGenerationLive(parsed.generation)) {
      throw new TypeError('MCP Apps replacement frame generation is not live');
    }
    this.#assertFreshBinding(parsed);
    this.#teardown('disconnected', new Error('MCP Apps frame was replaced'));
    this.connect(parsed);
  }

  disconnect(): void {
    if (this.#phase === 'closed') {
      return;
    }
    this.#teardown('disconnected', new Error('MCP Apps frame session disconnected'));
  }

  close(): void {
    this.#teardown('closed', new Error('MCP Apps frame session closed'));
  }

  requireReadyGeneration(): number {
    if (this.#phase !== 'ready' || this.#frame === undefined) {
      throw new TypeError('MCP Apps frame session is not initialized');
    }
    this.#assertGeneration(this.#frame.generation);
    return this.#frame.generation;
  }

  assertGeneration(generation: number): void {
    this.#assertGeneration(generation);
  }

  post(generation: number, message: unknown): void {
    try {
      const frame = this.#requireFrame(generation);
      frame.source.postMessage(message, '*');
    } catch (error: unknown) {
      const failure = toError(error, 'MCP Apps frame send failed');
      this.#fail(failure);
      throw failure;
    }
  }

  fail(error: Error): void {
    this.#fail(error);
  }

  #claim(
    generation: number,
    message: Readonly<{ kind: 'notification' | 'request'; method: string }>
  ): McpAppFrameSessionClaim {
    this.#assertGeneration(generation);
    const claimKind = this.#reservePhase(message);
    let settled = false;
    return Object.freeze({
      complete: (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.#frame?.generation !== generation) {
          return;
        }
        if (claimKind === 'initialize') {
          if (this.#phase !== 'initializing') {
            throw new TypeError('MCP Apps initialize claim is no longer active');
          }
          this.#phase = 'awaiting-initialized';
          return;
        }
        if (claimKind === 'initialized') {
          if (this.#phase !== 'accepting-initialized') {
            throw new TypeError('MCP Apps initialized claim is no longer active');
          }
          this.#phase = 'ready';
        }
      },
      fail: (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.#frame?.generation === generation) {
          this.#fail(error);
        }
      },
      generation,
      kind: claimKind,
    });
  }

  #reservePhase(
    message: Readonly<{ kind: 'notification' | 'request'; method: string }>
  ): McpAppFrameSessionClaim['kind'] {
    if (this.#phase === 'initializing') {
      throw new TypeError('MCP Apps frame sent traffic while ui/initialize is pending');
    }
    if (this.#phase === 'accepting-initialized') {
      throw new TypeError(
        'MCP Apps frame sent traffic while ui/notifications/initialized is pending'
      );
    }
    if (message.kind === 'request') {
      return this.#reserveRequest(message.method);
    }
    return this.#reserveNotification(message.method);
  }

  #reserveRequest(method: string): McpAppFrameSessionClaim['kind'] {
    if (this.#phase === 'awaiting-initialize') {
      if (method !== 'ui/initialize') {
        throw new TypeError('MCP Apps request arrived before ui/initialize');
      }
      this.#phase = 'initializing';
      return 'initialize';
    }
    if (this.#phase === 'awaiting-initialized') {
      throw new TypeError('MCP Apps request arrived before ui/notifications/initialized');
    }
    if (this.#phase !== 'ready') {
      throw new TypeError('MCP Apps frame session is not connected');
    }
    if (method === 'ui/initialize') {
      throw new TypeError('MCP Apps frame replayed ui/initialize');
    }
    return 'normal';
  }

  #reserveNotification(method: string): McpAppFrameSessionClaim['kind'] {
    if (this.#phase === 'awaiting-initialize') {
      throw new TypeError('MCP Apps notification arrived before initialization completed');
    }
    if (this.#phase === 'awaiting-initialized') {
      if (method !== 'ui/notifications/initialized') {
        throw new TypeError('MCP Apps notification arrived before initialization completed');
      }
      this.#phase = 'accepting-initialized';
      return 'initialized';
    }
    if (this.#phase !== 'ready') {
      throw new TypeError('MCP Apps frame session is not connected');
    }
    if (method === 'ui/notifications/initialized') {
      throw new TypeError('MCP Apps frame replayed ui/notifications/initialized');
    }
    return 'normal';
  }

  #parseBinding(binding: McpAppFrameBinding): McpAppFrameBinding {
    const generation = parsePositiveSafeInteger(binding.generation, 'MCP Apps frame generation');
    if (binding.origin !== OPAQUE_FRAME_ORIGIN) {
      throw new TypeError('MCP Apps frame origin must be the opaque "null" origin');
    }
    if (
      (typeof binding.source !== 'object' && typeof binding.source !== 'function') ||
      binding.source === null ||
      typeof binding.source.postMessage !== 'function'
    ) {
      throw new TypeError('MCP Apps frame source must support postMessage');
    }
    return Object.freeze({ generation, origin: OPAQUE_FRAME_ORIGIN, source: binding.source });
  }

  #assertFreshBinding(binding: McpAppFrameBinding): void {
    if (
      this.#highestConnectedGeneration !== undefined &&
      binding.generation <= this.#highestConnectedGeneration
    ) {
      throw new TypeError('MCP Apps frame generation must increase after teardown');
    }
    if (this.#usedSources.has(binding.source)) {
      throw new TypeError('MCP Apps frame reconnect must use a fresh source');
    }
  }

  #receive(event: McpAppFrameMessageEvent): void {
    const frame = this.#frame;
    if (frame === undefined) {
      return;
    }
    if (event.source !== frame.source) {
      this.#onProtocolError(
        new TypeError('MCP Apps message source does not match the connected frame')
      );
      return;
    }
    if (event.origin !== frame.origin) {
      this.#onProtocolError(
        new TypeError('MCP Apps message origin does not match the connected frame')
      );
      return;
    }
    if (!this.#isGenerationLive(frame.generation)) {
      this.#fail(new TypeError('MCP Apps frame generation is stale'));
      return;
    }
    try {
      this.#onMessage(
        event.data,
        Object.freeze({
          claim: (message: Readonly<{ kind: 'notification' | 'request'; method: string }>) =>
            this.#claim(frame.generation, message),
          generation: frame.generation,
        })
      );
    } catch (error: unknown) {
      this.#fail(toError(error, 'MCP Apps frame message validation failed'));
    }
  }

  #assertGeneration(generation: number): void {
    this.#requireFrame(generation);
  }

  #requireFrame(generation: number): McpAppFrameBinding {
    const frame = this.#frame;
    if (
      frame === undefined ||
      frame.generation !== generation ||
      !this.#isGenerationLive(generation)
    ) {
      throw new TypeError('MCP Apps frame generation is no longer live');
    }
    return frame;
  }

  #fail(error: Error): void {
    this.#teardown('disconnected', error);
    this.#onProtocolError(error);
  }

  #teardown(phase: 'closed' | 'disconnected', reason: Error): void {
    const hadConnection = this.#frame !== undefined || this.#listening;
    if (this.#listening) {
      this.#eventTarget.removeEventListener('message', this.#listener);
      this.#listening = false;
    }
    this.#frame = undefined;
    this.#phase = phase;
    if (hadConnection) {
      this.#onTeardown(reason);
    }
  }
}
