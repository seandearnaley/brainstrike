import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { RootLock, RootLockedError } from '@brainstrike/state-store';
import { Schema } from 'effect';

async function main(): Promise<void> {
  const root = makeThrowingDecoder(Schema.String)(process.argv[2]);
  try {
    const lease = await RootLock.acquire(root);
    lease.release();
    process.stdout.write(`${JSON.stringify({ event: 'acquired' })}\n`);
  } catch (cause) {
    if (!(cause instanceof RootLockedError)) {
      throw cause;
    }
    process.stdout.write(`${JSON.stringify({ event: 'refused', pid: cause.owner.pid })}\n`);
  }
}
main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exitCode = 1;
});
