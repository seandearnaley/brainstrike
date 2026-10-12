import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished } from 'vitest';

export interface DisposableAppProfile {
  /** Diagnostics the test writes; kept beside the root only when the test fails. */
  readonly evidence: string;
  /** The launched app's user data and DB root. */
  readonly root: string;
}

// A profile holds a PGlite database and the app's logs: removal takes seconds.
const TEARDOWN_TIMEOUT_MS = 60_000;

/**
 * A temporary root for one launched app, removed when the test finishes,
 * whether it passed, failed or threw before its own cleanup ran. Teardown
 * fails the test if the root survives removal.
 */
export async function createDisposableAppProfile(prefix: string): Promise<DisposableAppProfile> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const evidence = `${root}-evidence`;
  onTestFinished(async ({ task }) => {
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
    if (task.result?.state !== 'fail') {
      await rm(evidence, { force: true, recursive: true });
    }
    expect(existsSync(root), `The disposable profile ${root} outlived its test`).toBe(false);
  }, TEARDOWN_TIMEOUT_MS);
  await mkdir(evidence, { recursive: true });
  return { evidence, root };
}
