import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { buildWorkspaceRootManifestContextMessage } from '@brainstrike/agent/tool-runtime';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { readDesktopHostSystemContext } from '../agent-host-platform/desktop-host-context';

const workspaceRoots = [
  { displayName: 'main', path: '/work/main', rootId: 'root-main' },
  { displayName: 'focused', path: '/work/focused', rootId: 'root-focused' },
];

/** The host run's composed instructions under `runtime`. */
async function hostSystem(runtime: RuntimeData): Promise<string> {
  return z.string().parse(
    await readDesktopHostSystemContext({
      inputTokenLimit: 100_000,
      planMode: false,
      readWorkspaceFile: async () => {
        throw new Error('No workspace file is read by this run');
      },
      request: {
        modelId: 'openai::gpt-6-sol',
        prompt: 'Where am I working?',
        signal: new AbortController().signal,
        threadId: 'thread-roots',
      },
      runtime,
      tools: {},
    })
  );
}

/** The legacy per-turn root manifest text for `runtime`. */
function manifest(runtime: RuntimeData): string {
  const part = buildWorkspaceRootManifestContextMessage(runtime).parts[0];
  return part?.type === 'text' ? part.text : '';
}

test('a hosted run is told its workspace roots, main root and focused root, as legacy', async () => {
  const runtime: RuntimeData = {
    model: 'gpt-6-sol',
    provider: 'openai',
    selectionFolderId: 'root-focused',
    workspaceRoots,
  };
  const expected = manifest(runtime);
  expect(expected).toContain('root-focused');
  expect(await hostSystem(runtime)).toContain(expected);
});

test('a local run gets no root manifest, as legacy', async () => {
  const runtime: RuntimeData = { model: 'local-model', provider: 'local', workspaceRoots };
  expect(await hostSystem(runtime)).not.toContain(manifest({ ...runtime, provider: 'openai' }));
});
