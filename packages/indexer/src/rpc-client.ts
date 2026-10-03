import { decoder, frameSchema, IndexerError } from './contracts.js';

interface Pending {
  reject(error: unknown): void;
  resolve(value: unknown): void;
}
export class RpcClient {
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private failure: unknown;
  private readyResolve!: (value: unknown) => void;
  private readyReject!: (error: unknown) => void;
  readonly ready = new Promise<unknown>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  constructor(
    private readonly send: (message: object) => void,
    private readonly onFailure: () => void
  ) {}
  receive(input: unknown): void {
    try {
      const frame = decoder(frameSchema)(input);
      if (frame.kind === 'ready') {
        this.readyResolve(frame.value);
        return;
      }
      if (frame.kind === 'startup-error') {
        this.fail(new IndexerError(frame.error.code, frame.error.message));
        return;
      }
      const pending = this.pending.get(frame.id);
      if (!pending) {
        throw new TypeError(`Unexpected indexer response id ${frame.id}.`);
      }
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.value);
      } else {
        pending.reject(new IndexerError(frame.error.code, frame.error.message));
      }
    } catch (error) {
      this.fail(error);
    }
  }
  fail(error: unknown): void {
    if (this.failure !== undefined) {
      return;
    }
    this.failure = error;
    this.readyReject(this.failure);
    for (const pending of this.pending.values()) {
      pending.reject(this.failure);
    }
    this.pending.clear();
    this.onFailure();
  }
  assertActive(): void {
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }
  async call<T>(op: string, payload: unknown, decode: (value: unknown) => T): Promise<T> {
    this.assertActive();
    const id = ++this.sequence;
    const value = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      try {
        this.send({ id, op, payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    return decode(value);
  }
}
