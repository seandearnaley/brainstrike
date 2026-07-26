import { app, dialog } from 'electron';
import { initializeDesktopEnvironment } from './desktop-env';

function reportBootstrapFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Desktop environment bootstrap failed: ${message}\n`);
  try {
    dialog.showErrorBox('BrainStrike Desktop failed to start', message);
  } finally {
    app.exit(1);
  }
}

try {
  initializeDesktopEnvironment({
    appRoot: app.getAppPath(),
    argv: process.argv,
    env: process.env,
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
  });
  void import('./main').catch(reportBootstrapFailure);
} catch (error) {
  reportBootstrapFailure(error);
}
