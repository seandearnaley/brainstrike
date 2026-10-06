import { fileURLToPath } from 'node:url';
import { createNodeHostSpawner, type HostSpawner } from '@brainstrike/host-lease';

export function createAgentHostSpawner(platformModule: string): HostSpawner {
  return createNodeHostSpawner({
    entryArgs: [platformModule],
    entrypoint: fileURLToPath(new URL('./process-entry.js', import.meta.url)),
    output: 'ignore',
  });
}
