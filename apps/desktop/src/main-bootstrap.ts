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

// Release smoke-test contract (.github/workflows/release.yml): packaged
// Electron apps have no built-in --version handling — that lives in
// Electron's default_app, which is absent from packaged bundles — so without
// this the release smoke run would boot the full GUI and hang the CI job.
// Handled first, before any bootstrap work, so it cannot depend on app state.
if (process.argv.includes('--version')) {
  process.stdout.write(`${app.getVersion()}\n`);
  app.exit(0);
} else {
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
}
