import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop agent host compile cache (BST-2239)', () => {
  it('enables no Node compile cache before loading the host kernel, which runs without one too', () => {
    // Every Node instance persists what it compiled when it exits. Cold on hosted
    // windows-2025 the host thread's persist took 3537 ms of Main's 5 s lease close
    // (run 39340569328), for about 95 ms saved per warm start; the index workers' took
    // 1640 ms and 4028 ms inside their 1 s close and 1 s exit windows (run 39336738388).
    // The agent-host package's own entry is covered by compile-cache-workers.integration.test.ts.
    const entry = readFileSync(join(process.cwd(), 'src/agent-host-entry.ts'), 'utf8');

    expect(entry).not.toMatch(/compile-cache|CompileCache|NODE_COMPILE_CACHE/u);
  });
});
