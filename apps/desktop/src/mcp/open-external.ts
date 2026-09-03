interface ElectronShell {
  openExternal(url: string): Promise<void>;
}

function isElectronShell(value: unknown): value is ElectronShell {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'openExternal') === 'function'
  );
}

/** Hands an authorization URL to the OS browser through the Electron shell. */
export async function openExternalWithElectron(
  url: string,
  loadElectron: () => Promise<unknown> = async () => await import('electron')
): Promise<void> {
  const electron = await loadElectron();
  if (typeof electron !== 'object' || electron === null) {
    throw new Error('Electron shell module is unavailable.');
  }
  const direct = Reflect.get(electron, 'shell');
  const defaultExport = Reflect.get(electron, 'default');
  const nested =
    typeof defaultExport === 'object' && defaultExport !== null
      ? Reflect.get(defaultExport, 'shell')
      : undefined;
  const shell = isElectronShell(direct) ? direct : nested;
  if (!isElectronShell(shell)) {
    throw new Error('Electron shell module is unavailable.');
  }
  await shell.openExternal(url);
}
