// Loaded into a nested Vitest run with `--import`. The test that starts the run holds the only
// writer of the run's stdin, and the OS closes it however that test ends, SIGKILL included. At
// EOF the run ends its whole tree (its workers and their indexers), so a killed test runner
// leaves nothing behind (ADR-0030).
import { terminateTree } from '@brainstrike/state-store/native-children';

process.stdin.once('end', () => {
  terminateTree(process.pid).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(1);
  });
});
process.stdin.resume();
process.stdin.unref();
