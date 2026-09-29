// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createAssembledSubagentFixture } from '../../e2e/utils/subagent-integration-fixture';

it('keeps a native background wakeup on the parent script', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'assembled-script-'));
  const fixture = await createAssembledSubagentFixture(workspace);
  try {
    const response = await fetch(`${fixture.provider.baseUrl}/chat/completions`, {
      body: JSON.stringify({
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                function: { arguments: '{}', name: 'agent-stream-alpha' },
                id: 'alpha',
                type: 'function',
              },
            ],
          },
          { content: 'Background task started.', role: 'tool', tool_call_id: 'alpha' },
          {
            content:
              'Background wakeup: STREAM_ALPHA_TASK_1770 cancelled; STREAM_BETA_TASK_1770 running.',
            role: 'user',
          },
        ],
        tools: [{ function: { name: 'agent-stream-alpha' }, type: 'function' }],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: 'ASSEMBLED_ROOT_CONTINUES_1770' } }],
    });
  } finally {
    fixture.releaseAlpha();
    fixture.releaseBeta();
    await fixture.provider.close();
    await rm(workspace, { force: true, recursive: true });
  }
});
