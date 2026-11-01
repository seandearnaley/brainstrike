import {
  createProductionHostPlatform,
  type HostPlatform,
  type HostPlatformLaunchOptions,
  type HostStartupContext,
} from '@brainstrike/agent-host';
import type { HostStartOptions } from '@brainstrike/host-lease';

/** Writer authority already exists; the same production owner joins both acquisitions. */
export async function createHostPlatform(
  _options: HostStartOptions,
  startup: HostStartupContext,
  platformOptions?: HostPlatformLaunchOptions
): Promise<HostPlatform> {
  const { configuration, platform } = await createProductionHostPlatform({
    configure: async (context) => {
      const { createDesktopHostConfiguration } = await import(
        './agent-host-platform/desktop-node-platform'
      );
      return createDesktopHostConfiguration(context, platformOptions);
    },
    startup,
  });
  // Main binding, then the caller's purge replay/Core recovery, still precede publication.
  await configuration.confirmMainReady();
  return platform;
}
