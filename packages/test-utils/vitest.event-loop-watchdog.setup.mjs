// Vitest setup file for PGlite-hosting lanes: see vitest-event-loop-watchdog.mjs.
// A root-level .mjs (like vitest.base.mjs): setup files load in the vitest
// worker before any package build, and keeping it out of `src/` keeps the
// package's tsc build from treating the plain-JS watchdog as an input.
import { afterAll, beforeEach } from 'vitest';
import { startEventLoopWatchdog } from './vitest-event-loop-watchdog.mjs';

const watchdog = startEventLoopWatchdog();

beforeEach((context) => {
  watchdog.setLabel(`${context.task.file.name} › ${context.task.name}`);
});

afterAll(() => {
  watchdog.setLabel('between test files');
});
