/** Main's stores and services the agent host's own tools read through Main. */
import { mainBrowserToolRunner } from '../assistant-server/browser-agent-tools';
import { mainDiagnosticsReader } from '../assistant-server/query-diagnostics-tool';
import type { HostToolServiceCapabilities } from './host-tool-services';
import type { DesktopHostToolServices } from './production-desktop-capabilities';

/** The Main-owned stores and services host threads' own tools read through Main. */
export function desktopHostToolServices(
  dependencies: DesktopHostToolServices
): HostToolServiceCapabilities {
  return {
    ...(dependencies.nativeIndexSearch ? { indexSearch: dependencies.nativeIndexSearch } : {}),
    browser: mainBrowserToolRunner,
    diagnostics: mainDiagnosticsReader,
  };
}
