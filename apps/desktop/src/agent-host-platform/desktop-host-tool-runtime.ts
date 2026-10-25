/** Main's services the agent host's own tools reach through Main. */
import { mainBrowserToolRunner } from '../assistant-server/browser-agent-tools';
import { mainDiagnosticsReader } from '../assistant-server/query-diagnostics-tool';
import type { HostToolServiceCapabilities } from './host-tool-services';

/** The window-bound browser pane and Main's diagnostics store, for host threads' own tools. */
export const desktopHostToolServices: HostToolServiceCapabilities = {
  browser: mainBrowserToolRunner,
  diagnostics: mainDiagnosticsReader,
};
