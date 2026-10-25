#!/usr/bin/env node
/**
 * Install step: download the development Electron binary once, at install.
 *
 * Electron 44 has no install lifecycle: its first `require('electron')`
 * downloads and extracts the binary itself (BST-2221). On a fresh clone that
 * ran inside whichever test asked first, and parallel Playwright workers and
 * concurrent test lanes each extracted into the same folder, so one spawned a
 * binary another was still writing (spawn ETXTBSY). Running Electron's own
 * installer here does it serially, before anything launches Electron. It is a
 * no-op when the installed version is already present.
 *
 * ELECTRON_SKIP_BINARY_DOWNLOAD=1 skips it, as Electron's installer did before
 * 44. CI sets it on install and provisions the binary from a cache instead
 * (.github/actions/provision-electron), in the jobs that launch Electron.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.env['ELECTRON_SKIP_BINARY_DOWNLOAD'] === '1') {
  console.log('ELECTRON_SKIP_BINARY_DOWNLOAD=1: the Electron binary is not downloaded.');
} else {
  const require = createRequire(import.meta.url);
  execFileSync(process.execPath, [require.resolve('electron/install.js')], { stdio: 'inherit' });
}
