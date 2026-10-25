import {
  createProductionHostPlatform,
  type HostPlatform,
  type HostPlatformLaunchOptions,
  type HostPlatformRoot,
  type HostStartupContext,
} from '@brainstrike/agent-host';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';

/** Writer authority already exists; the same production owner joins both acquisitions. */
export async function createHostPlatform(
  _options: HostPlatformRoot,
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
    memoryResourceIds: [WORKSPACE_MEMORY_RESOURCE_ID],
    startup,
  });
  // Main binding, then the caller's purge replay/Core recovery, still precede publication.
  await configuration.confirmMainReady();
  return platform;
}
