export type DesktopRendererRole =
  | 'chunking-host'
  | 'embedding-host'
  | 'mcp-task-harness'
  | 'visible-ui';

export function resolveDesktopRendererRole(
  search: string,
  isTestMode: boolean
): DesktopRendererRole {
  const mode = new URLSearchParams(search).get('mode');
  if (mode === 'embedding-host') {
    return 'embedding-host';
  }
  if (mode === 'chunking-host') {
    return 'chunking-host';
  }
  if (mode === 'mcp-task-harness' && isTestMode) {
    return 'mcp-task-harness';
  }
  return 'visible-ui';
}
