import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';

test.skip(
  process.env['BRAINSTRIKE_PROOF_CPU_PROFILE'] !== '1',
  'Explicit proof qualification only.'
);

test('retains Main and agent-host CPU profiles for a successful fixture @smoke', async ({
  window,
}, testInfo) => {
  await expect(window.getByTestId('explorer-section')).toBeVisible();
  const output = testInfo.outputPath('proof-cpu');
  await expect
    .poll(async () => {
      const roles = new Set<string>();
      for (const directory of await readdir(output)) {
        const files = await readdir(path.join(output, directory));
        if (files.some((file) => file.endsWith('.cpuprofile'))) {
          roles.add(directory.startsWith('desktop-main-') ? 'desktop-main' : 'agent-host');
        }
      }
      return [...roles].sort();
    })
    .toEqual(['agent-host', 'desktop-main']);
  for (const directory of await readdir(output)) {
    const capture = await readFile(path.join(output, directory, 'capture.jsonl'), 'utf8');
    expect(capture).toContain('"event":"started"');
    expect(capture).toContain('"event":"segment"');
    expect(capture).not.toContain('"event":"failed"');
    expect(await readFile(path.join(output, directory, 'scripts.jsonl'), 'utf8')).toContain(
      '"baseline":false'
    );
  }
});
