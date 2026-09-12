// Vitest setup file for PGlite-hosting lanes: see vitest-event-loop-watchdog.mjs.
import { afterAll, beforeEach } from 'vitest';
import { startEventLoopWatchdog } from '../vitest-event-loop-watchdog.mjs';

const watchdog = startEventLoopWatchdog();

beforeEach((context) => {
  watchdog.setLabel(`${context.task.file.name} › ${context.task.name}`);
});

afterAll(() => {
  watchdog.setLabel('between test files');
});
