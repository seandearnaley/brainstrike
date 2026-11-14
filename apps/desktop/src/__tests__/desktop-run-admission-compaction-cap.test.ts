// @vitest-environment node
/**
 * BST-2539: a desktop run is admitted with the compaction cap its captured
 * intent carries, and an intent whose cap is below 64,000 tokens is refused.
 */
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import { expect, test } from 'vitest';
import { createDesktopRunAdmission } from '../agent-host-platform/desktop-run-admission';
import { capturedIntent, everyRootTrusted, mainReads } from './fixtures/desktop-admission-reads';

const admission = createDesktopRunAdmission(mainReads(), async () => undefined, everyRootTrusted);

function send(agentLoop: { readonly compactionTokenCap?: number }): HostRunAdmissionRequest {
  return {
    configuration: capturedIntent({ agentLoop, model: 'gpt-6-sol', provider: 'openai' }),
    modelId: 'openai::gpt-6-sol',
    runId: 'host-run',
    signal: new AbortController().signal,
    threadId: 'host-thread',
  };
}

test('a run is admitted with the compaction cap its intent carries, and none when it carries none', async () => {
  const capped = await admission.readConfiguration(send({ compactionTokenCap: 100_000 }));
  const uncapped = await admission.readConfiguration(send({}));
  try {
    expect(capped.compactionTokenCap).toBe(100_000);
    expect(uncapped.compactionTokenCap).toBeUndefined();
  } finally {
    await Promise.all([capped.close(), uncapped.close()]);
  }
});

test('an intent whose compaction cap is below 64,000 tokens is refused', async () => {
  await expect(admission.readConfiguration(send({ compactionTokenCap: 63_999 }))).rejects.toThrow(
    /greater than or equal to 64000\s+at \["agentLoop"\]\["compactionTokenCap"\]/u
  );
});
