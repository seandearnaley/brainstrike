import type { BoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';

export interface WorkspaceAckGate {
  arm(): void;
  closedDuringHold: boolean;
  closeRequested: boolean;
  failRead(): void;
  heldWrites: number;
  readHeld: boolean;
  release(): void;
  snapshot: unknown;
  threadId: string | null;
}

declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: Disposable transport gate, never installed by production.
    __BRAINSTRIKE_WORKSPACE_ACK_GATE__?: WorkspaceAckGate;
  }
}

/** Hold a real committed host response; the repository call remains admitted and unacknowledged. */
export function installWorkspaceAckGate(options: {
  readonly failure: BoundaryFailure;
  readonly failHydration: boolean;
}): void {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const requests = new WeakMap<
    MessagePort,
    Map<string | number, { method: string; params: unknown }>
  >();
  const started = new WeakSet<MessagePort>();
  const held: Array<{ port: MessagePort; data: unknown }> = [];
  let read: { port: MessagePort; data: Record<string, unknown> } | undefined;
  let armed = false;
  let replaying = false;
  const replay = (port: MessagePort, data: unknown): void => {
    replaying = true;
    try {
      port.dispatchEvent(new MessageEvent('message', { data }));
    } finally {
      replaying = false;
    }
  };
  const state: WorkspaceAckGate = {
    arm: () => {
      armed = true;
    },
    closedDuringHold: false,
    closeRequested: false,
    failRead: () => {
      if (!read) {
        throw new Error('No admitted workspace read is held');
      }
      const pending = read;
      read = undefined;
      state.readHeld = false;
      replay(pending.port, {
        error: { code: -32_603, data: options.failure, message: options.failure.message },
        id: pending.data['id'],
        jsonrpc: '2.0',
      });
    },
    heldWrites: 0,
    readHeld: false,
    release: () => {
      const responses = held.splice(0);
      state.heldWrites = 0;
      for (const response of responses) {
        replay(response.port, response.data);
      }
    },
    snapshot: null,
    threadId: null,
  };
  window.__BRAINSTRIKE_WORKSPACE_ACK_GATE__ = state;
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (
    message: unknown,
    ...rest: [transferOrOptions?: Transferable[] | StructuredSerializeOptions]
  ): void {
    if (
      isRecord(message) &&
      typeof message['method'] === 'string' &&
      (typeof message['id'] === 'string' || typeof message['id'] === 'number')
    ) {
      let pending = requests.get(this);
      if (!pending) {
        pending = new Map();
        requests.set(this, pending);
      }
      pending.set(message['id'], { method: message['method'], params: message['params'] });
    }
    Reflect.apply(post, this, [message, ...rest]);
  };
  const receiveWorkspace = (
    port: MessagePort,
    event: MessageEvent<unknown>,
    data: Record<string, unknown>,
    request: { method: string; params: Record<string, unknown> }
  ): void => {
    if (
      request.method === 'thread/workspace/read' &&
      options.failHydration &&
      !read &&
      !state.snapshot
    ) {
      event.stopImmediatePropagation();
      read = { data, port };
      state.readHeld = true;
      return;
    }
    if (
      request.method === 'thread/workspace/set' &&
      isRecord(data['result']) &&
      data['result']['accepted'] === true
    ) {
      event.stopImmediatePropagation();
      held.push({ data, port });
      state.snapshot = structuredClone(request.params['snapshot']);
      state.heldWrites = held.length;
    }
  };
  const receive = (port: MessagePort, event: MessageEvent<unknown>): void => {
    if (replaying || !armed || !isRecord(event.data)) {
      return;
    }
    const data = event.data;
    if (typeof data['id'] !== 'string' && typeof data['id'] !== 'number') {
      return;
    }
    const request = requests.get(port)?.get(data['id']);
    if (!request) {
      return;
    }
    if (
      request.method === 'thread/start' &&
      isRecord(data['result']) &&
      typeof data['result']['threadId'] === 'string'
    ) {
      state.threadId = data['result']['threadId'];
    }
    if (!isRecord(request.params) || request.params['threadId'] !== state.threadId) {
      return;
    }
    receiveWorkspace(port, event, data, { method: request.method, params: request.params });
  };
  const listen = (port: MessagePort): void => {
    if (started.has(port)) {
      return;
    }
    started.add(port);
    port.addEventListener('message', (event: MessageEvent<unknown>) => receive(port, event));
  };
  // MessagePort invokes target listeners in registration order, including capture listeners.
  // BrowserMessageReader assigns onmessage before start(), so install the gate before that setter.
  const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  const setOnMessage = descriptor?.set;
  if (!(descriptor && setOnMessage)) {
    throw new Error('MessagePort has no native onmessage setter');
  }
  Object.defineProperty(MessagePort.prototype, 'onmessage', {
    ...descriptor,
    set(this: MessagePort, listener: MessagePort['onmessage']) {
      listen(this);
      Reflect.apply(setOnMessage, this, [listener]);
    },
  });
  const start = MessagePort.prototype.start;
  MessagePort.prototype.start = function (): void {
    listen(this);
    Reflect.apply(start, this, []);
  };
  const close = MessagePort.prototype.close;
  MessagePort.prototype.close = function (): void {
    if (held.some((response) => response.port === this)) {
      state.closedDuringHold = true;
    }
    Reflect.apply(close, this, []);
  };
}
