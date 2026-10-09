/** A run-log event: a JSON object with a `type`. Its body is stored byte-exact as `JSON.stringify(event)`. */
export type RunEvent = Readonly<Record<string, unknown>> & { readonly type: string };

/** Content of a blob that must be durable before the event referencing it is appended. */
export interface BlobContent {
  readonly content: string;
  readonly hash: string;
}

export interface AppendItem {
  /** Blobs this event references (see `largeText`), written before the append in the same write-chain step. */
  readonly blobs?: readonly BlobContent[];
  readonly event: RunEvent;
  /** `false` keeps the row out of the hydration read (StateStore.readHydration); every other read still returns it. */
  readonly hydrate?: false;
  /** Raw (pre-coalescing) chunk count of a `ui.chunk` row. */
  readonly rawCount?: number;
  readonly threadId: string;
}

export interface LogRow {
  readonly event: RunEvent;
  /** The stored payload: the event body with `"seq"` written first. */
  readonly raw: string;
  readonly rawCount?: number;
  readonly seq: number;
  readonly threadId: string;
  /** Wall-clock append time (ms since epoch). */
  readonly ts?: number;
}

export type ThreadStatus =
  | { readonly kind: 'ok'; readonly tail: number }
  | { readonly kind: 'damaged'; readonly atSeq: number; readonly error: string };
