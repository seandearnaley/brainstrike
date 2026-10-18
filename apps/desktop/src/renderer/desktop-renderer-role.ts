export type DesktopRendererRole = 'chunking-host' | 'embedding-host' | 'visible-ui';

export function resolveDesktopRendererRole(search: string): DesktopRendererRole {
  const mode = new URLSearchParams(search).get('mode');
  if (mode === 'embedding-host') {
    return 'embedding-host';
  }
  if (mode === 'chunking-host') {
    return 'chunking-host';
  }
  return 'visible-ui';
}
