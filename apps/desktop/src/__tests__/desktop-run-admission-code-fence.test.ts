// @vitest-environment node
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { beforeEach, expect, test, vi } from 'vitest';
import { createDesktopRunAdmission } from '../agent-host-platform/desktop-run-admission';
import { capturedIntent, everyRootTrusted, mainReads } from './fixtures/desktop-admission-reads';

/** Whether this host has the OS fence: false is a Windows host. */
const fence = vi.hoisted(() => ({ supported: true }));
vi.mock('@brainstrike/agent/fence-executor', () => ({
  isFenceSupported: () => fence.supported,
}));
beforeEach(() => {
  fence.supported = true;
});

const alpha = { displayName: 'alpha', path: '/workspace/alpha', rootId: 'root-a' };

/** A send that enables a command and Python, as the composer's default tools do. */
function send(): HostRunAdmissionRequest {
  return {
    configuration: {
      ...capturedIntent({ model: 'gpt-6-sol', provider: 'openai' }),
      enabledNativeToolIds: [NATIVE_TOOL_ID.executeCommand, NATIVE_TOOL_ID.runPython],
    },
    modelId: 'openai::gpt-6-sol',
    runId: 'host-run',
    signal: new AbortController().signal,
    threadId: 'host-thread',
  };
}

async function offered(): Promise<{
  readonly ids: readonly string[];
  readonly system: string | undefined;
}> {
  const selected = await createDesktopRunAdmission(
    mainReads({ liveWorkspaceRoots: async () => [alpha] }),
    async () => undefined,
    everyRootTrusted
  ).readConfiguration(send());
  try {
    return {
      ids: Object.values(selected.tools).map((tool) => tool.permissionToolId ?? ''),
      system: selected.system,
    };
  } finally {
    await selected.close();
  }
}

test('a host with no OS fence offers no run_python, and the instructions name no Python', async () => {
  fence.supported = false;
  const { ids, system } = await offered();
  expect(ids).toContain(NATIVE_TOOL_ID.executeCommand);
  expect(ids).not.toContain(NATIVE_TOOL_ID.runPython);
  expect(system).not.toMatch(/Python|runPython/u);
});

test('a host with the OS fence offers run_python', async () => {
  const { ids, system } = await offered();
  expect(ids).toEqual(
    expect.arrayContaining([NATIVE_TOOL_ID.executeCommand, NATIVE_TOOL_ID.runPython])
  );
  expect(system).toMatch(/Python/u);
});
