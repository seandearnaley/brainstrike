/**
 * D1 regression proof: the suspended-run DISCOVERY path must build its runtime
 * with ZERO provider configuration and NO inference.
 *
 * Unlike mastra-tool-approval-suspend.spec.ts, this file deliberately does NOT
 * mock `../providers/provider-factory` — it exercises the REAL `getDefaultModel`
 * / `createProvider`. The mocked suites returned `getDefaultModel: () => 'fake-model'`,
 * which masked the live 500: the desktop discovery route builds the listing
 * runtime with `provider: 'ollama'`, but ollama has NO static default model, so
 * the pre-fix `createMastraAgentRuntime` threw `No default model configured for
 * provider: ollama` at init — before any listing ran (the `/assistant/suspended-runs`
 * 500 the smoke reproduced). With the inert listing-only model this path resolves
 * no provider/model and succeeds.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSuspendedMastraRuns } from '../mastra/agent-runtime';
import { createPgliteMastraMemory, type PgliteDatabase } from '../pglite-mastra-memory';

describe('listSuspendedMastraRuns (real provider-factory, zero provider config)', () => {
  let database: PGlite;

  beforeEach(() => {
    database = new PGlite();
  });

  afterEach(async () => {
    await database.close();
  });

  it('builds a listing runtime with a keyless provider that has no static default model (D1)', async () => {
    const { memory, storage } = await createPgliteMastraMemory({
      database: database as unknown as PgliteDatabase,
    });
    const thread = {
      resourceId: 'resource-discovery-d1',
      threadId: 'thread-discovery-d1',
    } as const;

    // Exactly the desktop route's runtime config: keyless `ollama`, no apiKey, no
    // model. Pre-fix this threw `No default model configured for provider: ollama`
    // during runtime init (the D1 500). Post-fix, listing resolves no model and
    // returns an empty result against the empty storage.
    const result = await listSuspendedMastraRuns(
      { resourceId: thread.resourceId, threadId: thread.threadId },
      {
        memory,
        runtime: {
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          provider: 'ollama',
        },
        storage,
      }
    );

    expect(result).toEqual({ approvals: [] });
  });
});
