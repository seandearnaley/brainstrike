/**
 * Contract between the SIGKILL crash-gate parent and its writer child: the ack
 * line, fixture ids, row caps and a seedable RNG. Dependency-free so the child
 * can import it without vitest.
 */

/** Marks a committed-transaction line on the child's stdout. */
export const ACK_PREFIX = 'acked ';
export const THREAD_ID = 'crash-thread';
export const RESOURCE_ID = 'crash-resource';
/** Rows kept per table, so a 200-iteration run churns instead of growing without bound. */
export const CHUNK_CAP = 4000;
export const INDEX_ROW_CAP = 1500;
/** Ordinals: `(run * SEQ_SPAN + seq) * CHUNK_STRIDE + i` must stay inside int32, so runs <= MAX_RUN. */
export const SEQ_SPAN = 10_000;
export const CHUNK_STRIDE = 100;
export const MAX_RUN = 1000;

/** What one committed transaction wrote; the parent asserts these survive the kill. */
export interface CrashAck {
  readonly chunkIds: readonly string[];
  readonly fileRecordId: string;
  readonly indexMessageIds: readonly string[];
  readonly messageId: string;
  readonly run: number;
  readonly seq: number;
}

export function formatAck(ack: CrashAck): string {
  return `${ACK_PREFIX}${JSON.stringify(ack)}\n`;
}

/** The acks in `output`, in order. A line torn by the kill was never a completed ack. */
export function parseAcks(output: string): CrashAck[] {
  const acks: CrashAck[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith(ACK_PREFIX)) {
      continue;
    }
    try {
      acks.push(JSON.parse(line.slice(ACK_PREFIX.length)) as CrashAck);
    } catch {
      // Only the final line can be torn.
    }
  }
  return acks;
}

/** mulberry32: small, seedable, identical on every platform. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A distinct, reproducible seed for one iteration of a run seeded with `seed`. */
export function iterationSeed(seed: number, iteration: number): number {
  return (seed + Math.imul(iteration, 0x9e_37_79_b1)) >>> 0;
}
