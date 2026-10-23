export type DesktopRendererRole = 'embedding-host' | 'visible-ui';

export function resolveDesktopRendererRole(search: string): DesktopRendererRole {
  const mode = new URLSearchParams(search).get('mode');
  if (mode === 'embedding-host') {
    return 'embedding-host';
  }
  return 'visible-ui';
}
