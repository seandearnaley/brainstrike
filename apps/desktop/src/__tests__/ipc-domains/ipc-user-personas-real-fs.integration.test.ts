import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createNodeFsScanDeps } from '../../assistant-server/node-fs-scan-deps';
import { listUserPersonas } from '../../ipc-user-personas-handlers';

it('loads a newly added home persona using the production secure filesystem scan', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-persona-native-scan-'));
  const fs = createNodeFsScanDeps();
  try {
    const directory = path.join(root, '.brainstrike', 'agents');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'home-scan-proof.md'),
      '---\ndescription: Availability proof\nmode: worker\nmodel: anthropic::bst1727-missing-model\ntools: bst1727_missing.edit, readWorkspaceFile\n---\nUse only permitted tools.'
    );
    const result = await listUserPersonas({
      fs,
      getDatabase: async () => null,
      homedir: () => root,
    });
    expect(result.personas.find((persona) => persona.id === 'home-scan-proof')).toMatchObject({
      mode: 'worker',
      status: 'ok',
    });
  } finally {
    fs.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
