import { app, dialog } from 'electron';
import { getDesktopBootstrapRuntime } from './desktop-bootstrap-runtime';
import { initializeDesktopEnvironment } from './desktop-env';
import { isDesktopShuttingDown, markDesktopShuttingDown } from './desktop-shutdown-state';

function reportBootstrapFailure(error: unknown, quitting = isDesktopShuttingDown()): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Desktop environment bootstrap failed: ${message}\n`);
  try {
    // An early quit failure must exit after reporting, not wait indefinitely
    // for acknowledgement of a modal startup dialog while shutdown is in flight.
    if (!quitting) {
      dialog.showErrorBox('BrainStrike Desktop failed to start', message);
    }
  } finally {
    app.exit(1);
  }
}

// Release smoke-test contract (.github/workflows/release.yml): packaged
// Electron apps have no built-in --version handling (that lives in Electron's
// default_app, absent from packaged bundles), so without this the release smoke
// run would boot the GUI, take the single-instance lock and start the agent
// host. Handled first, and app.exit does not stop this module's evaluation, so
// the bootstrap below sits in the other branch.
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
    const runtime = getDesktopBootstrapRuntime();
    if (runtime.singleInstanceLockAcquired) {
      const earlyQuit = (event: Electron.Event): void => {
        event.preventDefault();
        if (isDesktopShuttingDown()) {
          return;
        }
        markDesktopShuttingDown();
        void runtime.profile.retire().then(() => {
          app.removeListener('before-quit', earlyQuit);
          app.quit();
        }, reportBootstrapFailure);
      };
      app.on('before-quit', earlyQuit);
      void app
        .whenReady()
        .then(async () => {
          if (isDesktopShuttingDown()) {
            return;
          }
          // Fork with the existing owner before evaluating Main. The private platform
          // port queues until Main binds it; host publication joins that binding.
          const starting = runtime.profile.acquire();
          const started = Promise.allSettled([starting]);
          try {
            // A host-start refusal still reaches the existing Main error/retry UI.
            // Its original rejection is reported below after Main installs that path.
            await Promise.allSettled([runtime.waitForProfileLaunch(starting)]);
            if (isDesktopShuttingDown()) {
              return;
            }
            const main = await import('./main');
            app.removeListener('before-quit', earlyQuit);
            void starting.catch(main.reportAgentHostStartupFailure);
          } catch (cause) {
            const quitting = isDesktopShuttingDown();
            markDesktopShuttingDown();
            try {
              await runtime.profile.retire();
              await started;
            } catch (retirementFailure) {
              reportBootstrapFailure(retirementFailure, quitting);
              return;
            }
            reportBootstrapFailure(cause, quitting);
          }
        })
        .catch(reportBootstrapFailure);
    } else {
      app.quit();
    }
  } catch (error) {
    reportBootstrapFailure(error);
  }
}
