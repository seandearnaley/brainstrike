/** One public deadline owner, shared by all bundled agent entrypoints. */
export {
  readToolGuardDeadlineSignal,
  readToolGuardRemainingMs,
  registerToolGuardDeadlineSignal,
  reportToolGuardActivity,
  resolveGuardedToolSignal,
  toolGuardOwnsInactivity,
} from './tools/tool-guard-deadline';
