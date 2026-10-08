import { fileURLToPath } from 'node:url';
import { createNodeHostSpawner, type HostSpawner } from '@brainstrike/host-lease';
import {
  type HostPlatformLaunchOptions,
  HostPlatformLaunchOptionsSchema,
} from './platform-launch-options.js';

export function createAgentHostSpawner(
  platformModule: string,
  platformOptions?: HostPlatformLaunchOptions
): HostSpawner {
  return createNodeHostSpawner({
    entryArgs: [
      platformModule,
      ...(platformOptions
        ? [
            '--platform-options',
            JSON.stringify(HostPlatformLaunchOptionsSchema.parse(platformOptions)),
          ]
        : []),
    ],
    entrypoint: fileURLToPath(new URL('./process-entry.js', import.meta.url)),
    output: 'ignore',
  });
}
