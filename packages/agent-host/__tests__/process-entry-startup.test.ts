// ADR-0031: the host child's failed startup is reported first; its spans flush after the cleanup.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startupRelease } from '@brainstrike/state-store';
import { afterEach, expect, it, vi } from 'vitest';
import { openHostProcess } from '../src/process-entry.js';

const tracing = vi.hoisted(() => ({
  flush: Promise.withResolvers<void>(),
  shutdowns: 0,
}));
vi.mock('../src/telemetry/otel.js', () => ({
  startHostTracing: async () => ({
    shutdown: () => {
      tracing.shutdowns += 1;
      return tracing.flush.promise;
    },
  }),
}));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

it('rejects a failed startup while its tracing has not flushed, and flushes after its cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-host-process-'));
  roots.push(root);
  const modulePath = join(root, 'platform.mjs');
  await writeFile(
    modulePath,
    "export function createHostPlatform() { throw new Error('platform failed to start'); }\n"
  );

  const error = await openHostProcess(
    join(root, 'data'),
    modulePath,
    undefined,
    new AbortController().signal
  ).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ message: 'platform failed to start' });

  await vi.waitFor(() => expect(tracing.shutdowns).toBe(1));
  tracing.flush.resolve();
  await startupRelease(error);
});
