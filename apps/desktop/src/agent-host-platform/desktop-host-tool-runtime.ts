/** Main's stores and services the agent host's own tools read through Main. */
import { mainBrowserToolRunner } from '../assistant-server/browser-agent-tools';
import { mainDiagnosticsReader } from '../assistant-server/query-diagnostics-tool';
import type { HostToolServiceCapabilities } from './host-tool-services';

/** The Main-owned stores and services host threads' own tools read through Main. */
export const desktopHostToolServices: HostToolServiceCapabilities = {
  browser: mainBrowserToolRunner,
  diagnostics: mainDiagnosticsReader,
};
