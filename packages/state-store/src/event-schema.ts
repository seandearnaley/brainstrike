// Event upgraders, applied at every read boundary (M0-A2 src/schema.ts). Stored bytes are never rewritten: an older
// event stays stored in its version and is lifted, one version at a time, to the current shape whenever it is read.
// An event no upgrader or validator can interpret is never dropped: in dev mode the read throws, in prod it is shown in
// place as `unreadable`. The store owns only the tombstone; every other event shape belongs to the event producer.
import { TOMBSTONE_BODY } from './run-log-format.mjs';

export type Mode = 'dev' | 'prod';

export type LooseEvent = Readonly<Record<string, unknown>>;

/** What a prod reader shows in place of an event it cannot interpret. Never dropped. */
export interface Unreadable {
  readonly raw: string;
  readonly reason: string;
  readonly seq: number;
  readonly type: 'unreadable';
}

/** What a purge leaves behind. */
export interface Purged {
  readonly seq: number;
  readonly type: 'purged';
}

export class UnknownEventError extends Error {
  readonly seq: number;

  constructor(seq: number, reason: string) {
    super(`event seq ${seq}: ${reason}`);
    this.name = 'UnknownEventError';
    this.seq = seq;
  }
}

export interface EventSchema<E> {
  readonly currentVersion: number;
  /** `upgraders[v]` lifts a version-`v` event to version `v + 1`. */
  readonly upgraders: Readonly<Record<number, (o: LooseEvent) => LooseEvent>>;
  /** The typed current-version event, or the reason it is not one. */
  readonly validate: (o: LooseEvent, seq: number) => E | { readonly invalid: string };
}

export type Decoded<E> = E | Purged | Unreadable;

const PURGED_TYPE = (JSON.parse(TOMBSTONE_BODY) as { type: string }).type;

function fail(mode: Mode, seq: number, raw: string, reason: string): Unreadable {
  if (mode === 'dev') {
    throw new UnknownEventError(seq, reason);
  }
  return { raw, reason, seq, type: 'unreadable' };
}

export function decodeEvent<E>(raw: string, mode: Mode, schema: EventSchema<E>): Decoded<E> {
  let o: LooseEvent;
  try {
    o = JSON.parse(raw) as LooseEvent;
  } catch (e) {
    return fail(mode, -1, raw, `unparseable: ${(e as Error).message}`);
  }
  const seq = typeof o['seq'] === 'number' ? o['seq'] : -1;
  if (o['type'] === PURGED_TYPE) {
    return { seq, type: 'purged' };
  }
  let v = o['v'];
  while (typeof v === 'number' && v < schema.currentVersion) {
    const up = schema.upgraders[v];
    if (!up) {
      break;
    }
    o = up(o);
    const lifted = o['v'];
    // An upgrader that does not raise the version would loop forever; stop, and let the version check below fail.
    if (typeof lifted !== 'number' || lifted <= v) {
      break;
    }
    v = lifted;
  }
  if (o['v'] !== schema.currentVersion) {
    return fail(mode, seq, raw, `unknown event version ${JSON.stringify(o['v'])}`);
  }
  const out = schema.validate(o, seq);
  if (typeof out === 'object' && out !== null && 'invalid' in out) {
    return fail(mode, seq, raw, (out as { readonly invalid: string }).invalid);
  }
  return out;
}
