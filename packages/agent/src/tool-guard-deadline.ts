/** One public deadline owner, shared by all bundled agent entrypoints. */
export {
  readToolGuardDeadlineSignal,
  registerToolGuardDeadlineSignal,
  reportToolGuardActivity,
  resolveGuardedToolSignal,
} from './tools/tool-guard-deadline';
